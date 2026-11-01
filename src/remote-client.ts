import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceRequestParams,
  type ReadResourceResult
} from "@modelcontextprotocol/client";
import type { BridgeOptions } from "./cli.js";
import { publicError } from "./errors.js";
import type { Logger } from "./logging.js";

/** Owns one remote MCP session. Failed calls are never retried. */
export class RemotePhosClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<Client>;

  public constructor(private readonly options: BridgeOptions, private readonly logger: Logger) {}

  public async connect(): Promise<void> { await this.connected(); }

  public supportsTools(): boolean {
    return Boolean(this.client?.getServerCapabilities()?.tools);
  }

  public supportsResources(): boolean {
    return Boolean(this.client?.getServerCapabilities()?.resources);
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
    this.logger.info(`connecting to PHOS at ${this.options.url.origin}${this.options.url.pathname}`);
    const transport = new StreamableHTTPClientTransport(this.options.url, {
      requestInit: { headers: this.options.headers },
      // A dropped session is recovered only before a *future* request.
      reconnectionOptions: { maxReconnectionDelay: 5_000, initialReconnectionDelay: 250, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 }
    });
    transport.onclose = () => {
      this.logger.warn("PHOS MCP session closed; the next request will establish a fresh session.");
      if (this.transport === transport) { this.transport = undefined; this.client = undefined; }
    };
    transport.onerror = error => this.logger.debug(`remote transport: ${error.message}`);
    const client = new Client({ name: "phos-mcp-bridge", version: "0.1.0" });
    try {
      await withTimeout(client.connect(transport), this.options.connectTimeoutMs, "connection to PHOS MCP server timed out");
    } catch (error) {
      try { await transport.close(); } catch { /* ignored */ }
      throw publicError(error);
    }
    this.transport = transport;
    this.client = client;
    this.logger.info("connected to PHOS MCP server");
    return client;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
