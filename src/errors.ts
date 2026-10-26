export function publicError(error: unknown): Error {
  if (error instanceof Error && isMcpError(error)) return error;
  const message = errorText(error);
  if (/ECONNREFUSED|\bconnect\s+E[A-Z]+/i.test(message)) return new Error("PHOS MCP server refused the connection");
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(message)) return new Error("Unable to resolve the PHOS MCP server hostname");
  if (/certificate|self signed|TLS|SSL/i.test(message)) return new Error("TLS validation failed while connecting to the PHOS MCP server");
  if (/abort|timeout|timed out/i.test(message)) return new Error("Request to the PHOS MCP server timed out");
  return new Error("PHOS MCP transport error: " + message.replace(/\s*at\s+.*$/s, ""));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause ? `${error.message} ${errorText(cause)}` : error.message;
}

function isMcpError(error: Error): boolean {
  return "code" in error && typeof (error as { code?: unknown }).code === "number";
}
