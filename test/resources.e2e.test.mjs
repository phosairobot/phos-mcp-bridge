import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

async function startFakeRemote() {
  let resources = [
    { uri: "test://dynamic-resource", name: "Dynamic resource", description: "Added outside the bridge", mimeType: "application/json" },
    { uri: "test://plain-text", name: "Plain text", mimeType: "text/plain" },
    { uri: "test://blob", name: "Blob", mimeType: "application/octet-stream" }
  ];
  const server = new Server({ name: "fake-remote", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "ping", description: "test", inputSchema: { type: "object" } }] }));
  server.setRequestHandler("tools/call", async request => ({ content: [{ type: "text", text: `pong:${request.params.name}` }] }));
  server.setRequestHandler("resources/list", async () => ({ resources }));
  server.setRequestHandler("resources/read", async request => {
    if (request.params.uri === "test://dynamic-resource") {
      return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify({ dynamic: true }) }] };
    }
    if (request.params.uri === "test://plain-text") {
      return { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "forwarded text" }] };
    }
    if (request.params.uri === "test://blob") {
      return { contents: [{ uri: request.params.uri, mimeType: "application/octet-stream", blob: "AAEC" }] };
    }
    throw new Error("Unknown resource URI");
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => "test-session", enableJsonResponse: true });
  await server.connect(transport);

  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `http://127.0.0.1${request.url}`;
    const webRequest = new Request(url, { method: request.method, headers: request.headers, body });
    const webResponse = await transport.handleRequest(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    addResource: resource => { resources = [...resources, resource]; },
    setResources: next => { resources = next; },
    close: async () => {
      await transport.close();
      await new Promise(resolve => http.close(resolve));
    }
  };
}

test("forwards dynamic remote resources through stdio without changing tools", async () => {
  const remote = await startFakeRemote();
  const stdio = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js", "--url", remote.url], stderr: "pipe" });
  const client = new Client({ name: "resource-e2e", version: "1.0.0" });
  try {
    await client.connect(stdio);
    const listed = await client.listResources(undefined, { cacheMode: "refresh" });
    assert.deepEqual(listed.resources, [
      { uri: "test://dynamic-resource", name: "Dynamic resource", description: "Added outside the bridge", mimeType: "application/json" },
      { uri: "test://plain-text", name: "Plain text", mimeType: "text/plain" },
      { uri: "test://blob", name: "Blob", mimeType: "application/octet-stream" }
    ]);
    const json = await client.readResource({ uri: "test://dynamic-resource" }, { cacheMode: "refresh" });
    assert.deepEqual(json.contents, [{ uri: "test://dynamic-resource", mimeType: "application/json", text: '{"dynamic":true}' }]);
    const plain = await client.readResource({ uri: "test://plain-text" }, { cacheMode: "refresh" });
    assert.equal(plain.contents[0].mimeType, "text/plain");
    assert.equal(plain.contents[0].text, "forwarded text");
    assert.deepEqual(await client.readResource({ uri: "test://blob" }, { cacheMode: "refresh" }), {
      contents: [{ uri: "test://blob", mimeType: "application/octet-stream", blob: "AAEC" }]
    });
    await assert.rejects(client.readResource({ uri: "test://unknown" }, { cacheMode: "refresh" }), /Unknown resource URI/);
    remote.addResource({ uri: "test://added-later", name: "Added later", mimeType: "text/plain" });
    assert.equal((await client.listResources(undefined, { cacheMode: "refresh" })).resources.at(-1).uri, "test://added-later");
    remote.setResources([]);
    assert.deepEqual((await client.listResources(undefined, { cacheMode: "refresh" })).resources, []);
    assert.deepEqual((await client.listTools(undefined, { cacheMode: "refresh" })).tools.map(tool => tool.name), ["ping"]);
    assert.deepEqual(await client.callTool({ name: "ping" }), { content: [{ type: "text", text: "pong:ping" }] });
  } finally {
    await stdio.close();
    await remote.close();
  }
});
