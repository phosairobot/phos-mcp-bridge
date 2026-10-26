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

test("token becomes an authorization header without changing other headers", () => {
  const options = parseCli(["--url", "https://phos.example/mcp", "--header", "X-Site: lab", "--token", "secret"], {});
  assert.deepEqual(options.headers, { "X-Site": "lab", Authorization: "Bearer secret" });
});
