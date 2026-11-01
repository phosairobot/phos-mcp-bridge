import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { BridgeOptions } from "./cli.js";
import { Logger } from "./logging.js";
import { RemotePhosClient } from "./remote-client.js";

export interface BridgeHandle { close(): Promise<void>; }

export async function startBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const logger = new Logger(options.logLevel);
  // Node's built-in fetch honours this process-only switch. It is set solely for
  // an explicit --insecure invocation and never for ordinary HTTPS connections.
  if (options.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const remote = new RemotePhosClient(options, logger);
  // Complete the remote MCP negotiation before accepting a local client.
  await remote.connect();
  const remoteCapabilities = remote.getServerCapabilities();
  const server = new Server(
    { name: "phos-mcp-bridge", version: "0.1.0" },
    {
      capabilities: {
        ...(remote.supportsTools() ? {
          tools: { ...(remoteCapabilities?.tools?.listChanged ? { listChanged: true } : {}) }
        } : {}),
        ...(remote.supportsResources() ? {
          resources: {
            ...(remoteCapabilities?.resources?.listChanged ? { listChanged: true } : {}),
            ...(remoteCapabilities?.resources?.subscribe ? { subscribe: true } : {})
          }
        } : {})
      }
    }
  );
  server.setRequestHandler("tools/list", async request =>
    remote.listTools(request.params?.cursor)
  );
  server.setRequestHandler("tools/call", async request =>
    remote.callTool(request.params)
  );
  server.setRequestHandler("resources/list", async request =>
    remote.listResources(request.params?.cursor)
  );
  server.setRequestHandler("resources/read", async request =>
    remote.readResource(request.params)
  );
  server.setRequestHandler("resources/subscribe", async request => remote.subscribeResource(request.params));
  server.setRequestHandler("resources/unsubscribe", async request => remote.unsubscribeResource(request.params));
  await remote.forwardSubscriptions(async notification => {
    if (notification.method === "notifications/resources/updated") {
      logger.debug(`emitting stdio resource update: ${notification.params.uri}`);
      await server.notification({
        method: "notifications/resources/updated",
        params: { uri: notification.params.uri }
      });
      return;
    }
    await server.notification(notification);
  });
  const stdio = new StdioServerTransport();
  stdio.onerror = error => logger.error(error.message);
  await server.connect(stdio);

  return {
    async close(): Promise<void> {
      await server.close();
      await remote.close();
    }
  };
}
