#!/usr/bin/env node
import { parseCli, writeStartupWarning } from "./cli.js";
import { startBridge } from "./bridge.js";

async function main(): Promise<void> {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    const options = parseCli(process.argv.slice(2));
    if (!options) return;
    writeStartupWarning(options);
    bridge = await startBridge(options);
  } catch (error) {
    process.stderr.write(`[phos-mcp-bridge] error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const shutdown = async () => { await bridge?.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main();

export { startBridge } from "./bridge.js";
export { parseCli, type BridgeOptions } from "./cli.js";
