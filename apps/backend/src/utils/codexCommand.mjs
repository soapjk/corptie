import { resolveExternalCommand, externalCommandCandidates } from "./externalCommand.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const appBundleNames = ["Codex", "ChatGPT"];
// Current desktop builds ship the CLI as a launcher in a nested bundle instead
// of a bare binary in Resources. Keep both layouts so an App update or rollback
// never silently removes the only executable Corptie can discover.
const appBundleBinaryPaths = [join("codex-cli", "bin", "codex"), "codex"];

function defaultAppBundleRoots() {
  return ["/Applications", join(homedir(), "Applications")];
}

function appBundleCandidates(roots) {
  return roots.flatMap(root => appBundleNames.flatMap(name =>
    appBundleBinaryPaths.map(relative => ({
      path: join(root, `${name}.app`, "Contents", "Resources", relative),
      source: name
    }))));
}

export function controlledCodexCommand() {
  return process.env.CORPTIE_CODEX_PATH || process.env.CORPTIE_CODEX_REAL_PATH || null;
}

// Desktop bundles are a fallback: a PATH-installed CLI is always offered first,
// and discovery marks the bundled prerelease build in the setup UI. `roots` is
// injectable so the layout can be tested without writing into /Applications.
export function codexExecutableCandidates({ roots = defaultAppBundleRoots() } = {}) {
  return [...externalCommandCandidates("codex").map(path => ({ path, source: "cli" })),
    ...appBundleCandidates(roots)];
}

export function resolveCodexCommand(requestedCommand = "") {
  return resolveExternalCommand("codex", {
    requested: requestedCommand,
    environmentVariables: ["CORPTIE_CODEX_PATH", "CORPTIE_CODEX_REAL_PATH"],
    extraCandidates: appBundleCandidates(defaultAppBundleRoots()).map(entry => entry.path)
  });
}
