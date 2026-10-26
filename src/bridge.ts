import { Server } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
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
  let stdio: StdioServerHandle | undefined;
  stdio = serveStdio(async () => {
    const server = new Server(
      { name: "phos-mcp-bridge", version: "0.1.0" },
      { capabilities: remote.supportsTools() ? { tools: {} } : {} }
    );
    server.setRequestHandler("tools/list", async request =>
      remote.listTools(request.params?.cursor)
    );
    server.setRequestHandler("tools/call", async request =>
      remote.callTool(request.params)
    );
    return server;
  }, { onerror: error => logger.error(error.message) });

  return {
    async close(): Promise<void> {
      await stdio?.close();
      await remote.close();
    }
  };
}
