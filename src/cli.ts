import { Logger, type LogLevel } from "./logging.js";

export interface BridgeOptions {
  url: URL;
  timeoutMs: number;
  connectTimeoutMs: number;
  headers: Record<string, string>;
  insecure: boolean;
  logLevel: LogLevel;
}

const usage = `Usage: phos-mcp-bridge --url <http(s)://host/mcp> [options]

Options:
  --url <url>                 PHOS MCP Streamable HTTP endpoint (or PHOS_MCP_URL)
  --timeout <milliseconds>    Request timeout (default: 30000; PHOS_MCP_TIMEOUT)
  --connect-timeout <ms>      Initial connection timeout (default: 10000)
  --header <Name: value>      Extra HTTP header; repeatable
  --token <token>             Sends Authorization: Bearer <token> (or PHOS_MCP_TOKEN)
  --insecure                  Disable TLS certificate verification (development only)
  --log-level <level>         silent, error, warn, info, or debug (default: error)
  --help                      Print this help to stderr
`;

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeOptions | undefined {
  const values: Record<string, string[]> = {};
  let insecure = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") { process.stderr.write(usage); return undefined; }
    if (flag === "--insecure") { insecure = true; continue; }
    if (!flag.startsWith("--")) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    (values[flag] ??= []).push(value);
  }
  const rawUrl = values["--url"]?.at(-1) ?? env.PHOS_MCP_URL;
  if (!rawUrl) throw new Error("--url is required (or set PHOS_MCP_URL)");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("--url must be a valid HTTP or HTTPS URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must use http:// or https://");
  const timeoutMs = integer(values["--timeout"]?.at(-1) ?? env.PHOS_MCP_TIMEOUT ?? "30000", "--timeout");
  const connectTimeoutMs = integer(values["--connect-timeout"]?.at(-1) ?? "10000", "--connect-timeout");
  const logLevel = (values["--log-level"]?.at(-1) ?? "error") as LogLevel;
  if (!Object.hasOwn({ silent: 1, error: 1, warn: 1, info: 1, debug: 1 }, logLevel)) throw new Error("--log-level must be silent, error, warn, info, or debug");
  const headers: Record<string, string> = {};
  for (const entry of values["--header"] ?? []) {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("--header must be formatted as 'Name: value'");
    headers[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  const token = values["--token"]?.at(-1) ?? env.PHOS_MCP_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (insecure && url.protocol !== "https:") throw new Error("--insecure is valid only with an HTTPS URL");
  return { url, timeoutMs, connectTimeoutMs, headers, insecure, logLevel };
}

export function writeStartupWarning(options: BridgeOptions, logger = new Logger(options.logLevel)): void {
  if (options.insecure) logger.warn("TLS certificate validation is DISABLED by --insecure; use only for development.");
}

function integer(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${option} must be a positive integer in milliseconds`);
  return value;
}
