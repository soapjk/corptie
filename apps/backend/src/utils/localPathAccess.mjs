import { accessSync, constants } from "node:fs";
import { stat, mkdir } from "node:fs/promises";

export function isExecutable(path) {
  if (typeof path !== "string" || !path.trim()) {
    return false;
  }
  try {
    accessSync(path.trim(), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathExists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function assertDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (!info) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${path}`);
  }
}
