import { basename } from "node:path";
import { COMPUTER_USE_BRIDGE_PROFILE } from "./computerUseBridge.mjs";
import { BUILTIN_COMPUTER_USE_PROFILE } from "./computerUseProfiles.mjs";

// A protocol selector, not an authorization grant. The normal assignment and
// per-Session permission gates still run for every invocation.
export function isComputerUseMcpConfig(config = {}) {
  return isBuiltinComputerUseConfig(config) || isComputerUseBridgeConfig(config) || isNativeComputerUseMcpConfig(config);
}

export function isBuiltinComputerUseConfig(config = {}) {
  return config.runtimeProfile === BUILTIN_COMPUTER_USE_PROFILE && (config.type ?? config.transport) === "stdio";
}

export function isComputerUseBridgeConfig(config = {}) {
  return config.runtimeProfile === COMPUTER_USE_BRIDGE_PROFILE && (config.type ?? config.transport) === "stdio";
}

export function isNativeComputerUseMcpConfig(config = {}) {
  if (!/^(node_repl|node_repl\.exe)$/.test(basename(config.command ?? ""))) return false;
  try {
    return JSON.parse(config.env?.NODE_REPL_TRUSTED_SERVICES ?? "null")?.sky === "@oai/sky/service";
  } catch { return false; }
}
