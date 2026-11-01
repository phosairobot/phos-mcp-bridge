import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceRequestParams,
  type ReadResourceResult,
  type SubscribeRequestParams,
  type UnsubscribeRequestParams
} from "@modelcontextprotocol/client";
import type { BridgeOptions } from "./cli.js";
import { publicError } from "./errors.js";
import type { Logger } from "./logging.js";

type ChangeNotification =
  | { method: "notifications/tools/list_changed" }
  | { method: "notifications/resources/list_changed" }
  | { method: "notifications/resources/updated"; params: { uri: string } };

type RemoteSubscription = { close(): Promise<void> };

/** Owns one remote MCP session. Failed calls are never retried. */
export class RemotePhosClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<Client>;
  private subscription?: RemoteSubscription;
  private notificationSink?: (notification: ChangeNotification) => void | Promise<void>;
  private readonly subscribedResources = new Set<string>();
  private subscriptionUpdate: Promise<void> = Promise.resolve();

  public constructor(private readonly options: BridgeOptions, private readonly logger: Logger) {}

  public async connect(): Promise<void> { await this.connected(); }

  public supportsTools(): boolean {
    return Boolean(this.client?.getServerCapabilities()?.tools);
  }

  public supportsResources(): boolean {
    return Boolean(this.client?.getServerCapabilities()?.resources);
  }

  public getServerCapabilities() {
    return this.client?.getServerCapabilities();
  }

  /**
   * Deliver remote change notifications to the local stdio server. The local
   * SDK's listen router applies each stdio client's individual filter.
   */
  public async forwardSubscriptions(sink: (notification: ChangeNotification) => void | Promise<void>): Promise<void> {
    this.notificationSink = sink;
    await this.replaceSubscription(await this.connected());
  }

  public supportsResourceSubscriptions(): boolean {
    return Boolean(this.client?.getServerCapabilities()?.resources?.subscribe);
  }

  public async subscribeResource(params: SubscribeRequestParams): Promise<Record<string, never>> {
    const client = await this.connected();
    if (client.getProtocolEra() === "legacy") {
      try {
        await client.subscribeResource(params, { timeout: this.options.timeoutMs });
        return {};
      } catch (error) { throw publicError(error); }
    }
    this.subscribedResources.add(params.uri);
    await this.queueSubscriptionReplacement();
    return {};
  }

  public async unsubscribeResource(params: UnsubscribeRequestParams): Promise<Record<string, never>> {
    const client = await this.connected();
    if (client.getProtocolEra() === "legacy") {
      try {
        await client.unsubscribeResource(params, { timeout: this.options.timeoutMs });
        return {};
      } catch (error) { throw publicError(error); }
    }
    this.subscribedResources.delete(params.uri);
    await this.queueSubscriptionReplacement();
    return {};
  }

  public async listTools(cursor?: string): Promise<ListToolsResult> {
    const client = await this.connected();
    try {
      return await client.listTools(cursor ? { cursor } : undefined, { cacheMode: "refresh", timeout: this.options.timeoutMs });
    } catch (error) { throw publicError(error); }
  }

  public async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> {
    const client = await this.connected();
    try {
      // Never retry a tool call: PHOS may already have performed a physical action.
      return await client.callTool(params, { timeout: this.options.timeoutMs });
    } catch (error) { throw publicError(error); }
  }

  public async listResources(cursor?: string): Promise<ListResourcesResult> {
    const client = await this.connected();
    try {
      // PHOS is authoritative: do not serve a locally cached resource list.
      return await client.listResources(cursor ? { cursor } : undefined, {
        cacheMode: "refresh",
        timeout: this.options.timeoutMs
      });
    } catch (error) { throw publicError(error); }
  }

  public async readResource(params: ReadResourceRequestParams): Promise<ReadResourceResult> {
    const client = await this.connected();
    try {
      // Preserve the SDK's structured text/blob result without conversion.
      return await client.readResource(params, {
        cacheMode: "refresh",
        timeout: this.options.timeoutMs
      });
    } catch (error) { throw publicError(error); }
  }

  public async close(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = undefined;
    try { await subscription?.close(); } catch { /* best-effort subscription teardown */ }
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    try { await transport?.terminateSession(); } catch { /* best-effort session teardown */ }
    try { await transport?.close(); } catch { /* best-effort local teardown */ }
  }

  private async connected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.open();
    try { return await this.connecting; }
    finally { if (!this.client) this.connecting = undefined; }
  }

  private async open(): Promise<Client> {
    try {
      return await this.openConnection(true);
    } catch (error) {
      // Some pre-2026 Streamable HTTP servers reject the discovery probe
      // without a usable fallback response. Reopen a clean legacy session so
      // existing PHOS deployments keep their previous behavior.
      this.logger.debug(`modern MCP negotiation failed; retrying legacy connection: ${publicError(error).message}`);
      try { return await this.openConnection(false); }
      catch (legacyError) { throw publicError(legacyError); }
    }
  }

  private async openConnection(negotiateModern: boolean): Promise<Client> {
    this.logger.info(`connecting to PHOS at ${this.options.url.origin}${this.options.url.pathname}`);
    const transport = new StreamableHTTPClientTransport(this.options.url, {
      requestInit: { headers: this.options.headers },
      // A dropped session is recovered only before a *future* request.
      reconnectionOptions: { maxReconnectionDelay: 5_000, initialReconnectionDelay: 250, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 }
    });
    transport.onclose = () => {
      this.logger.warn("PHOS MCP session closed; the next request will establish a fresh session.");
      if (this.transport === transport) {
        this.subscription = undefined;
        this.transport = undefined;
        this.client = undefined;
      }
    };
    transport.onerror = error => this.logger.debug(`remote transport: ${error.message}`);
    const client = new Client(
      { name: "phos-mcp-bridge", version: "0.1.0" },
      negotiateModern ? { versionNegotiation: { mode: "auto" } } : undefined
    );
    client.setNotificationHandler("notifications/tools/list_changed", () => this.notificationSink?.({ method: "notifications/tools/list_changed" }));
    client.setNotificationHandler("notifications/resources/list_changed", () => this.notificationSink?.({ method: "notifications/resources/list_changed" }));
    client.setNotificationHandler("notifications/resources/updated", notification => {
      this.logger.debug(`received PHOS resource update: ${JSON.stringify(notification)}`);
      const uri = notification.params?.uri;
      if (typeof uri !== "string") {
        this.logger.debug("ignoring PHOS resource update without a string params.uri");
        return;
      }
      if (client.getProtocolEra() === "modern" && !this.subscribedResources.has(uri)) {
        this.logger.debug(`ignoring PHOS resource update outside the local subscription set: ${uri}`);
        return;
      }
      this.logger.debug(`forwarding PHOS resource update to stdio: ${uri}`);
      return this.notificationSink?.({ method: "notifications/resources/updated", params: { uri } });
    });
    try {
      await withTimeout(client.connect(transport), this.options.connectTimeoutMs, "connection to PHOS MCP server timed out");
    } catch (error) {
      try { await transport.close(); } catch { /* ignored */ }
      throw error;
    }
    this.transport = transport;
    this.client = client;
    this.logger.info("connected to PHOS MCP server");
    await this.replaceSubscription(client);
    return client;
  }

  private async queueSubscriptionReplacement(): Promise<void> {
    this.subscriptionUpdate = this.subscriptionUpdate
      .catch(() => undefined)
      .then(async () => this.replaceSubscription(await this.connected()));
    return this.subscriptionUpdate;
  }

  private async replaceSubscription(client: Client): Promise<void> {
    if (!this.notificationSink || client.getProtocolEra() !== "modern") return;
    const capabilities = client.getServerCapabilities();
    const filter = {
      ...(capabilities?.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(capabilities?.resources?.listChanged ? { resourcesListChanged: true } : {}),
      ...(capabilities?.resources?.subscribe && this.subscribedResources.size > 0
        ? { resourceSubscriptions: [...this.subscribedResources] }
        : {})
    };
    const previous = this.subscription;
    this.subscription = undefined;
    try { await previous?.close(); } catch { /* best-effort stream replacement */ }
    if (Object.keys(filter).length === 0) return;
    try {
      this.subscription = await client.listen(filter, { timeout: this.options.connectTimeoutMs });
      this.logger.info("forwarding PHOS subscription notifications");
    } catch (error) {
      // Requests remain usable when a server advertises a capability but does
      // not accept a subscription stream.
      this.logger.warn(`PHOS subscription forwarding unavailable: ${publicError(error).message}`);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
