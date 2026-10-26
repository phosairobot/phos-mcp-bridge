export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const rank: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export class Logger {
  public constructor(private readonly level: LogLevel) {}

  public error(message: string): void { this.write("error", message); }
  public warn(message: string): void { this.write("warn", message); }
  public info(message: string): void { this.write("info", message); }
  public debug(message: string): void { this.write("debug", message); }

  private write(level: Exclude<LogLevel, "silent">, message: string): void {
    if (rank[this.level] >= rank[level]) process.stderr.write(`[phos-mcp-bridge] ${level}: ${message}\n`);
  }
}
