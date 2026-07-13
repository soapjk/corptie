import { resolveExternalCommand } from "./externalCommand.mjs";

const codexAppBundleBinaries = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex"
];

export function resolveCodexCommand(requestedCommand = "") {
  return resolveExternalCommand("codex", {
    requested: requestedCommand,
    environmentVariables: ["CORPTIE_CODEX_PATH", "CORPTIE_CODEX_REAL_PATH"],
    extraCandidates: codexAppBundleBinaries
  });
}
