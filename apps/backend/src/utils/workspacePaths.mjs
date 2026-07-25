import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function defaultWorkspacePath(options = {}) {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const configured = String(environment.CORPTIE_DEFAULT_WORKSPACE ?? "").trim();
  if (configured && isAbsolute(configured)) {
    return resolve(configured);
  }
  return resolve(join(home, "corptie"));
}

export function sessionWorkspacePath(value, options = {}) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) {
    return defaultWorkspacePath(options);
  }
  if (!isAbsolute(requested)) {
    const error = new Error("Workspace path must be absolute.");
    error.code = "INVALID_WORKSPACE_PATH";
    throw error;
  }
  return resolve(requested);
}
