export function publicError(error: unknown, redact: (text: string) => string = text => text): Error {
  const message = redact(errorText(error)).replace(/authorization\s*[:=]\s*bearer\s+[^\s,;"}]+/gi, "Authorization: Bearer [REDACTED]");
  if (/\b401\b|\bunauthenticated\b|\bunauthorized\b|\bauthentication\s+(?:failed|required)\b|\binvalid\s+(?:bearer|token|credential)\b/i.test(message)) {
    return new Error("PHOS authentication failed");
  }
  // Preserve a PHOS MCP code (such as permission_denied), without returning an
  // upstream message that could contain a request header.
  if (error instanceof Error && isMcpError(error)) {
    const safe = new Error(message) as Error & { code?: number };
    safe.code = (error as Error & { code: number }).code;
    return safe;
  }
  if (/ECONNREFUSED|\bconnect\s+E[A-Z]+/i.test(message)) return new Error("PHOS MCP server refused the connection");
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(message)) return new Error("Unable to resolve the PHOS MCP server hostname");
  if (/certificate|self signed|TLS|SSL/i.test(message)) return new Error("TLS validation failed while connecting to the PHOS MCP server");
  if (/abort|timeout|timed out/i.test(message)) return new Error("Request to the PHOS MCP server timed out");
  return new Error("PHOS MCP transport error: " + message.replace(/\s*at\s+.*$/s, ""));
}

export function isAuthenticationFailure(error: unknown): boolean {
  return /\b401\b|\bunauthenticated\b|\bunauthorized\b|\bauthentication\s+(?:failed|required)\b|\binvalid\s+(?:bearer|token|credential)\b/i.test(errorText(error));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause ? `${error.message} ${errorText(cause)}` : error.message;
}

function isMcpError(error: Error): boolean {
  return "code" in error && typeof (error as { code?: unknown }).code === "number";
}
