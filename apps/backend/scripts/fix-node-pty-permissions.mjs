import { chmod, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import process from "node:process";

if (process.platform !== "darwin") {
  process.exit(0);
}

const helperPath = join(
  process.cwd(),
  "node_modules",
  "node-pty",
  "prebuilds",
  process.arch === "arm64" ? "darwin-arm64" : "darwin-x64",
  "spawn-helper"
);

try {
  await access(helperPath, constants.F_OK);
  await chmod(helperPath, 0o755);
} catch {
  // node-pty may be rebuilt from source or absent during partial installs.
}
