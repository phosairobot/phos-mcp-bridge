import test from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../dist/cli.js";

test("parses --url", () => {
  const options = parseCli(["--url", "http://192.168.1.50:8001/mcp"], {});
  assert.equal(options.url.href, "http://192.168.1.50:8001/mcp");
});

test("uses PHOS_MCP_URL as a fallback", () => {
  const options = parseCli([], { PHOS_MCP_URL: "https://phos.example.com/mcp" });
  assert.equal(options.url.href, "https://phos.example.com/mcp");
});

test("CLI URL overrides PHOS_MCP_URL", () => {
  const options = parseCli(["--url", "http://local.test/mcp"], { PHOS_MCP_URL: "https://ignored.test/mcp" });
  assert.equal(options.url.href, "http://local.test/mcp");
});

test("environment token supplies a private authorization header without appearing in public config", () => {
  const secret = "PHOS_BRIDGE_SECRET_NEVER_LOG_82A1";
  const options = parseCli(["--url", "https://phos.example/mcp", "--header", "X-Site: lab"], { PHOS_MCP_TOKEN: secret });
  assert.deepEqual(options.headers, { "X-Site": "lab" });
  assert.deepEqual(options.authHeaders(), { Authorization: `Bearer ${secret}` });
  assert.equal(options.authToken(), secret);
  assert.doesNotMatch(JSON.stringify(options), new RegExp(secret));
});

test("missing or empty environment token sends no authorization header", () => {
  assert.deepEqual(parseCli(["--url", "https://phos.example/mcp"], {}).authHeaders(), {});
  assert.deepEqual(parseCli(["--url", "https://phos.example/mcp"], { PHOS_MCP_TOKEN: "  " }).authHeaders(), {});
  assert.equal(parseCli(["--url", "https://phos.example/mcp"], {}).authToken(), undefined);
});

test("rejects visible credential options", () => {
  assert.throws(() => parseCli(["--url", "https://phos.example/mcp", "--token", "secret"], {}), /not supported/);
  assert.throws(() => parseCli(["--url", "https://phos.example/mcp", "--header", "Authorization: Bearer secret"], {}), /PHOS_MCP_TOKEN/);
});
