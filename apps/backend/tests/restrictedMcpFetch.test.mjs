import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { allowedMcpAddress, pinnedMcpAddress, restrictedMcpFetch } from "../src/application/restrictedMcpFetch.mjs";

test("MCP address policy rejects private and reserved destinations, including mixed DNS results", () => {
  for (const address of ["10.1.2.3", "100.64.1.1", "127.0.0.1", "169.254.1.1", "172.20.1.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2002::1"]) {
    assert.equal(allowedMcpAddress(address, "mcp.example.com"), false, address);
  }
  assert.equal(allowedMcpAddress("8.8.8.8", "mcp.example.com"), true);
  assert.equal(allowedMcpAddress("2606:4700:4700::1111", "mcp.example.com"), true);
  assert.equal(allowedMcpAddress("127.0.0.1", "localhost"), true);
  assert.equal(allowedMcpAddress("::1", "localhost"), true);
  assert.equal(allowedMcpAddress("127.0.0.1", "localhost.example.com"), false);
});

test("MCP DNS pinning rejects a mixed public and private answer before connecting", async () => {
  const target = new URL("https://mcp.example.com/tools");
  const resolveMixed = async (_hostname, options) => {
    assert.equal(options.all, true);
    return [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }];
  };
  await assert.rejects(pinnedMcpAddress(target, resolveMixed), { code: "MCP_REMOTE_ADDRESS_DENIED" });
  assert.deepEqual(await pinnedMcpAddress(target, async () => [{ address: "8.8.8.8", family: 4 }]), {
    address: "8.8.8.8", family: 4
  });
});

test("MCP DNS pinning times out before a stalled lookup can start a connection", async () => {
  await assert.rejects(pinnedMcpAddress(new URL("https://mcp.example.com/tools"),
    () => new Promise(() => {}), 10),
  { code: "MCP_REMOTE_DNS_TIMEOUT", statusCode: 504 });
});

test("MCP fetch rejects a different origin before making a request", async () => {
  let called = false;
  const guarded = restrictedMcpFetch("https://mcp.example.test/api", async () => {
    called = true;
    return new Response(null, { status: 200 });
  });
  assert.throws(() => guarded("http://127.0.0.1/private"), { code: "MCP_REMOTE_ORIGIN_DENIED" });
  assert.throws(() => guarded("https://other.example.test/api"), { code: "MCP_REMOTE_ORIGIN_DENIED" });
  assert.throws(() => guarded("https://user:pass@mcp.example.test/api"), { code: "MCP_REMOTE_ORIGIN_DENIED" });
  assert.equal(called, false);
});

test("MCP fetch disables redirects on allowed same-origin requests", async () => {
  let observed;
  const guarded = restrictedMcpFetch("https://mcp.example.test/api", async (url, init) => {
    observed = { url, init };
    return new Response(null, { status: 200 });
  });
  await guarded("https://mcp.example.test/events", { method: "GET", redirect: "follow" });
  assert.equal(observed.url, "https://mcp.example.test/events");
  assert.equal(observed.init.method, "GET");
  assert.equal(observed.init.redirect, "error");
});

test("MCP fetch rejects same-origin redirects without following them", async () => {
  const guarded = restrictedMcpFetch("https://mcp.example.test/api", async () => new Response(null, {
    status: 302,
    headers: { location: "/private" }
  }));
  await assert.rejects(guarded("https://mcp.example.test/api"), { code: "MCP_REMOTE_REDIRECT_DENIED" });
});

test("MCP fetch sends a streamed POST to an explicitly configured loopback endpoint", async (t) => {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ method: request.method, body }));
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip(`Loopback bind unavailable: ${error.code}`);
    throw error;
  }
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const response = await restrictedMcpFetch(url)(url, { method: "POST", body: "payload" });
    assert.deepEqual(await response.json(), { method: "POST", body: "payload" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
