import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const blockedIPv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blockedIPv4.addSubnet(address, prefix, "ipv4");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [["2001:db8::", 32], ["2002::", 16], ["2001::", 32]]) {
  blockedIPv6.addSubnet(address, prefix, "ipv6");
}

function denied(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  return error;
}

export function allowedMcpAddress(address, hostname) {
  const unbracketed = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(unbracketed)) {
    return address === "127.0.0.1" || address === "::1";
  }
  const family = isIP(address);
  if (family === 4) return !blockedIPv4.check(address, "ipv4");
  if (family === 6) return globalIPv6.check(address, "ipv6") && !blockedIPv6.check(address, "ipv6");
  return false;
}

export async function pinnedMcpAddress(target, lookupImpl = lookup, timeoutMs = 8_000) {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    let timer;
    try {
      addresses = await Promise.race([
        lookupImpl(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = denied("MCP_REMOTE_DNS_TIMEOUT", "MCP remote address lookup timed out.");
            error.statusCode = 504;
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!Array.isArray(addresses) || !addresses.length
    || addresses.some((entry) => !entry || typeof entry.address !== "string"
      || !allowedMcpAddress(entry.address, hostname))) {
    throw denied("MCP_REMOTE_ADDRESS_DENIED", "MCP remote address is not permitted.");
  }
  return addresses[0];
}

async function pinnedFetch(input, init) {
  const request = new Request(input, { ...init, redirect: "manual", duplex: "half" });
  const target = new URL(request.url);
  const address = await pinnedMcpAddress(target);
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const outgoing = client.request(target, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      agent: false,
      autoSelectFamily: false,
      signal: request.signal,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve(new Response([204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming), {
        status: incoming.statusCode,
        statusText: incoming.statusMessage,
        headers
      }));
    });
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("MCP remote request timed out.")));
    outgoing.on("error", reject);
    if (request.body) Readable.fromWeb(request.body).on("error", reject).pipe(outgoing);
    else outgoing.end();
  });
}

// Keep credentials on the configured origin; the default transport also pins
// each connection to a checked DNS result, preventing DNS rebinding after validation.
export function restrictedMcpFetch(serverUrl, fetchImpl = pinnedFetch) {
  const configured = new URL(serverUrl);
  if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) {
    throw denied("MCP_REMOTE_URL_DENIED", "MCP remote URL is not permitted.");
  }
  return (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== configured.origin || target.username || target.password) {
      throw denied("MCP_REMOTE_ORIGIN_DENIED", "MCP transport requested a different origin.");
    }
    return fetchImpl(input, { ...init, redirect: "error" }).then((response) => {
      if (response.status >= 300 && response.status < 400) {
        response.body?.cancel();
        throw denied("MCP_REMOTE_REDIRECT_DENIED", "MCP remote redirect is not permitted.");
      }
      return response;
    });
  };
}
