import { resolveExternalCommand, externalCommandCandidates } from "./externalCommand.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const codexAppBundleBinaries = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex"
];

export function controlledCodexCommand() {
  return process.env.CORPTIE_CODEX_PATH || process.env.CORPTIE_CODEX_REAL_PATH || null;
}

export function codexExecutableCandidates() {
  return [...externalCommandCandidates("codex").map(path => ({ path, source: "cli" })),
    ...["/Applications", join(homedir(), "Applications")].flatMap(root =>
      ["Codex", "ChatGPT"].map(name => ({ path: join(root, `${name}.app`, "Contents", "Resources", "codex"), source: name })))];
}

export function resolveCodexCommand(requestedCommand = "") {
  return resolveExternalCommand("codex", {
    requested: requestedCommand,
    environmentVariables: ["CORPTIE_CODEX_PATH", "CORPTIE_CODEX_REAL_PATH"],
    extraCandidates: codexAppBundleBinaries
  });
}
