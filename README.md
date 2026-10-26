# PHOS MCP Bridge

`@phos/phos-mcp-bridge` is a standalone Node.js 20+ transport bridge for a
remote PHOS MCP server. It exposes MCP over local stdio and forwards it to
PHOS over MCP Streamable HTTP. It does not start PHOS or include PHOS runtime,
robot, hardware, or Python dependencies.

```text
MCP stdio client → phos-mcp-bridge → MCP Streamable HTTP → PHOS
```

The remote server remains authoritative. The bridge dynamically forwards
`tools/list` and `tools/call`, so newly published PHOS tools require no bridge
change. Tool results, input schemas, metadata, structured output, and tool
error results pass through unchanged.

## Install and run

```bash
npm install -g @phos/phos-mcp-bridge
phos-mcp-bridge --url http://192.168.1.50:8001/mcp
```

Or run it without installing globally:

```bash
npx -y @phos/phos-mcp-bridge --url https://phos.example.com/mcp
```

Options:

```text
--url <url>                 Required unless PHOS_MCP_URL is set
--timeout <milliseconds>    Per-request timeout (default: 30000)
--connect-timeout <ms>      Initial MCP connection timeout (default: 10000)
--header "Name: value"      Extra HTTP header; may be repeated
--token <token>             Sends Authorization: Bearer <token>
--insecure                  Explicitly disable HTTPS certificate validation
--log-level <level>         silent, error, warn, info, debug
```

`PHOS_MCP_URL`, `PHOS_MCP_TOKEN`, and `PHOS_MCP_TIMEOUT` provide environment
defaults. CLI values take precedence. Credentials are never logged. HTTPS
certificate validation is enabled by default; `--insecure` is for development
only and emits a stderr warning.

All human diagnostics are written to stderr. stdout is reserved exclusively
for MCP stdio traffic.

## Claude Code

Claude Code currently supports local stdio servers through `claude mcp add`.
The following adds this bridge in the current project scope:

```bash
claude mcp add phos -- npx -y @phos/phos-mcp-bridge \
  --url http://192.168.1.50:8001/mcp
```

Use `--scope user` before `phos` to make it available across projects. For a
checked-in project configuration, use this `.mcp.json` entry:

```json
{
  "mcpServers": {
    "phos": {
      "command": "npx",
      "args": ["-y", "@phos/phos-mcp-bridge", "--url", "http://192.168.1.50:8001/mcp"]
    }
  }
}
```

On native Windows, wrap `npx` as `cmd /c npx` when configuring a stdio server.
This follows the current [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp).

## Claude Desktop

For a local-development stdio server, add the following to the `mcpServers`
section of `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "phos": {
      "command": "npx",
      "args": ["-y", "@phos/phos-mcp-bridge", "--url", "http://192.168.1.50:8001/mcp"]
    }
  }
}
```

Claude Desktop’s current recommended installation path is a Desktop Extension;
manual local-development MCP configuration is supported when enabled by the
desktop policy. See Anthropic’s [Claude Desktop local MCP guide](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The bridge never automatically retries `tools/call`, including after a broken
transport connection, because PHOS might have executed a physical action.
Future requests establish a fresh MCP session when the previous one closes.
