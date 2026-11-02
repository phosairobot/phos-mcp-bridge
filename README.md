# PHOS MCP Bridge

`phos-mcp-bridge` is a standalone Node.js 20+ transport bridge for a remote
PHOS MCP server. It exposes MCP over local stdio and forwards it to PHOS over
MCP Streamable HTTP. It does not start PHOS or include PHOS runtime, robot,
hardware, or Python dependencies.

```text
MCP stdio client → phos-mcp-bridge → MCP Streamable HTTP → PHOS
```

The remote server remains authoritative. The bridge dynamically forwards
`tools/list`, `tools/call`, `resources/list`, and `resources/read`, so newly
published PHOS tools and resources require no bridge change. Tool results,
resource metadata (including URI and MIME type), and structured text/blob
resource contents pass through unchanged. Resource listings and reads are
refreshed from the remote server for each request; a replacement remote session
therefore cannot retain stale bridge resource state.

When PHOS advertises modern MCP change-notification capabilities, the bridge
also maintains one long-lived remote `subscriptions/listen` stream and forwards
tool/resource-list change notifications to local stdio subscribers. Each local
resource subscription is enforced by the bridge's subscribed-URI set.
When PHOS advertises `resources.subscribe`, the bridge advertises it locally
and tracks the subscribed resource URIs. On a modern PHOS session it replaces
the one upstream `subscriptions/listen` stream with an updated
`resourceSubscriptions` filter; on a legacy session it forwards the SDK's
`resources/subscribe` and `resources/unsubscribe` operations directly.

## Build and run locally

This package is not published to npm yet. Build it from this repository:

```bash
npm install
npm run build
node dist/index.js --url http://<PHOS_IP>:8001/mcp
```

## PHOS authentication

To connect to a PHOS deployment that requires MCP authentication, set the
credential in the bridge process environment (not in its command line or URL):

```bash
export PHOS_MCP_TOKEN='credential-issued-by-phos'
node dist/index.js --url http://<PHOS_IP>:8001/mcp
```

`PHOS_MCP_TOKEN` is optional. If it is absent or empty, the bridge sends no
`Authorization` header, retaining compatibility with legacy PHOS deployments.
When configured, the bridge applies `Authorization: Bearer <credential>` once
through the MCP SDK's remote Streamable HTTP transport, covering
initialization, normal requests, and long-lived subscription streams (including
fresh sessions after a transport reconnect).

The token is issued, rotated, revoked, and validated by PHOS Web Admin/PHOS;
the bridge neither validates credentials nor resolves identities or permissions.
Keep it in a secret manager or the MCP launcher's environment configuration.
Credential rotation requires updating that secret source and restarting the
bridge. A revoked, missing, or invalid credential causes a sanitized PHOS
authentication failure. PHOS authorization results, including
`permission_denied` for observer credentials and camera resources, pass through
unchanged.

Do not put credentials in `--url`, `--header`, or command-line arguments. The
bridge deliberately rejects `--token` and `--header Authorization: ...` to
avoid shell history and process-list exposure. Its normal and debug logs redact
authorization values.

## Claude Code

Claude Code currently supports local stdio servers through `claude mcp add`.
Build the bridge first, then configure Node to run the compiled entry point.
Use an **absolute path** for `dist/index.js`: Claude Code can launch MCP
servers with a working directory other than this repository, so a relative
path such as `dist/index.js` is not reliable.

```bash
claude mcp add phos -- node \
  /absolute/path/to/phos-mcp-bridge/dist/index.js \
  --url http://<PHOS_IP>:8001/mcp
```

For example, for a checkout at `/Users/xxx/Documents/dev/phos-mcp-bridge`:

```bash
claude mcp add phos -- node \
  /Users/xxxxx/Documents/dev/phos-mcp-bridge/dist/index.js \
  --url http://<PHOS_IP>:8001/mcp
```

Use `--scope user` before `phos` to make it available across projects. For a
checked-in project configuration, use this `.mcp.json` entry (replace the path
and PHOS address for each developer):

```json
{
  "mcpServers": {
    "phos": {
      "command": "node",
      "args": [
        "/absolute/path/to/phos-mcp-bridge/dist/index.js",
        "--url",
        "http://<PHOS_IP>:8001/mcp"
      ]
    }
  }
}
```

For a shared configuration, prefer an environment variable or a developer-local
MCP configuration instead of committing a machine-specific absolute path. On
native Windows, use an absolute Windows path, for example
`C:\\dev\\phos-mcp-bridge\\dist\\index.js`; if `node` is not on the
launcher's `PATH`, use its absolute path as `command` too.
This follows the current [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp).

## Claude Desktop

For a local-development stdio server, add the following to the `mcpServers`
section of `claude_desktop_config.json`, then restart Claude Desktop. As with
Claude Code, build first and use an **absolute** path to `dist/index.js`.

```json
{
  "mcpServers": {
    "phos": {
      "command": "node",
      "args": [
        "/absolute/path/to/phos-mcp-bridge/dist/index.js",
        "--url",
        "http://<PHOS_IP>:8001/mcp"
      ]
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

For Inspector, provide the secret to the Inspector/bridge process environment,
not after its `--` separator:

```bash
PHOS_MCP_TOKEN='credential-issued-by-phos' \
  npx --yes @modelcontextprotocol/inspector@latest --tui \
  --protocol-era modern \
  node /absolute/path/to/phos-mcp-bridge/dist/index.js \
  -- --url http://<PHOS_IP>:8001/mcp
```
