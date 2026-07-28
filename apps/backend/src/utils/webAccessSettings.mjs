import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export function defaultWebAccessPort(environmentName = "production") {
  return environmentName === "development" ? 47324 : 47323;
}

export function normalizeWebAccessSettings(input = {}, options = {}) {
  const environmentName = options.environmentName === "development" ? "development" : "production";
  let enabled = input.enabled === true;
  const httpsEnabled = input.httpsEnabled !== false;
  let host = typeof input.host === "string" ? input.host.trim() : "";
  const fallbackPort = defaultWebAccessPort(environmentName);
  const parsedPort = Number(input.port);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
    ? parsedPort
    : fallbackPort;

  if (host && isIP(host) === 0) {
    throw new Error("Web Access host must be an explicit IPv4 or IPv6 address.");
  }
  if (host === "0.0.0.0" || host === "::") {
    throw new Error("Web Access cannot bind every network interface. Select one explicit address.");
  }
  if (isLoopbackAddress(host)) {
    if (enabled && options.rejectLoopback === true) {
      throw new Error("Web Access cannot use a loopback address. Select this Mac's LAN address.");
    }
    enabled = false;
    host = "";
  }
  if (enabled && !host) {
    throw new Error("Web Access requires an explicit network interface address.");
  }

  return {
    enabled,
    host,
    port,
    httpsEnabled
  };
}

export function listLanAddresses(interfaces = networkInterfaces()) {
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (isVirtualInterface(name)) continue;
    for (const entry of entries ?? []) {
      const family = entry.family;
      if ((family !== "IPv4" && family !== 4)
        || entry.internal
        || !isShareableIPv4Address(entry.address)) {
        continue;
      }
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort((left, right) => addressPriority(left) - addressPriority(right));
}

export function isLoopbackAddress(host) {
  return host === "::1" || /^127\./.test(host);
}

function isShareableIPv4Address(address) {
  return isIP(address) === 4
    && !isLoopbackAddress(address)
    && !address.startsWith("169.254.")
    && address !== "0.0.0.0";
}

function isVirtualInterface(name) {
  return /^(lo|utun|awdl|llw|bridge|anpi|gif|stf)/i.test(name);
}

function addressPriority(address) {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  const second = Number(address.split(".")[1]);
  if (address.startsWith("172.") && second >= 16 && second <= 31) return 2;
  return 3;
}
