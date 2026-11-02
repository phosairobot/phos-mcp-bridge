import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { parseCli } from "../dist/cli.js";
import { Logger } from "../dist/logging.js";
import { RemotePhosClient } from "../dist/remote-client.js";

async function startFakeRemote({ resourceSubscriptions = true, expectedToken } = {}) {
  const subscribedResources = new Set();
  let resources = [
    { uri: "test://dynamic-resource", name: "Dynamic resource", description: "Added outside the bridge", mimeType: "application/json" },
    { uri: "test://plain-text", name: "Plain text", mimeType: "text/plain" },
    { uri: "test://blob", name: "Blob", mimeType: "application/octet-stream" }
  ];
  const server = new Server(
    { name: "fake-remote", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, ...(resourceSubscriptions ? { subscribe: true } : {}) }
      }
    }
  );
  const authorizations = [];
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
  server.setRequestHandler("resources/subscribe", async request => {
    subscribedResources.add(request.params.uri);
    return {};
  });
  server.setRequestHandler("resources/unsubscribe", async request => {
    subscribedResources.delete(request.params.uri);
    return {};
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => "test-session", enableJsonResponse: true });
  await server.connect(transport);

  const http = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    if (expectedToken && request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication failed" }));
      return;
    }
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
    subscribedResources,
    authorizations,
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
    assert.equal(client.getServerCapabilities()?.resources?.subscribe, true);
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
    await client.subscribeResource({ uri: "phos://status" });
    assert.deepEqual([...remote.subscribedResources], ["phos://status"]);
    await client.subscribeResource({ uri: "phos://environment" });
    assert.deepEqual([...remote.subscribedResources].sort(), ["phos://environment", "phos://status"]);
    await client.unsubscribeResource({ uri: "phos://status" });
    assert.deepEqual([...remote.subscribedResources], ["phos://environment"]);
  } finally {
    await stdio.close();
    await remote.close();
  }
});

test("forwards an environment bearer to initialization, calls, resources, and subscriptions", async () => {
  const secret = "PHOS_BRIDGE_SECRET_NEVER_LOG_82A1";
  const remote = await startFakeRemote({ expectedToken: secret });
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--url", remote.url, "--log-level", "debug"],
    env: { ...process.env, PHOS_MCP_TOKEN: secret },
    stderr: "pipe"
  });
  const client = new Client({ name: "authenticated-e2e", version: "1.0.0" });
  try {
    await client.connect(stdio);
    await client.listTools(undefined, { cacheMode: "refresh" });
    await client.callTool({ name: "ping" });
    await client.listResources(undefined, { cacheMode: "refresh" });
    await client.readResource({ uri: "test://plain-text" }, { cacheMode: "refresh" });
    await client.subscribeResource({ uri: "phos://status" });
    assert.ok(remote.authorizations.length >= 6);
    assert.ok(remote.authorizations.every(value => value === `Bearer ${secret}`));
    const stderr = await stdio.stderr;
    if (stderr) assert.doesNotMatch(String(stderr), new RegExp(secret));
  } finally {
    await stdio.close();
    await remote.close();
  }
});

test("protected PHOS reports a sanitized authentication failure without an unauthenticated fallback", async () => {
  const remote = await startFakeRemote({ expectedToken: "standard-token" });
  const secret = "PHOS_BRIDGE_SECRET_NEVER_LOG_82A1";
  const options = parseCli(["--url", remote.url], { PHOS_MCP_TOKEN: secret });
  const client = new RemotePhosClient(options, new Logger("silent", options.redact));
  try {
    await assert.rejects(client.connect(), error => {
      assert.match(error.message, /PHOS authentication failed/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.equal(remote.authorizations.length, 1);
    assert.equal(remote.authorizations[0], `Bearer ${secret}`);
  } finally {
    await client.close();
    await remote.close();
  }
});

test("does not advertise resource subscriptions when PHOS does not support them", async () => {
  const remote = await startFakeRemote({ resourceSubscriptions: false });
  const stdio = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js", "--url", remote.url], stderr: "pipe" });
  const client = new Client({ name: "capability-e2e", version: "1.0.0" });
  try {
    await client.connect(stdio);
    assert.notEqual(client.getServerCapabilities()?.resources?.subscribe, true);
  } finally {
    await stdio.close();
    await remote.close();
  }
});
