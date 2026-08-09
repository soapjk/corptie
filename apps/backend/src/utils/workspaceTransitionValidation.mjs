import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export async function validateWorkspaceInstructionSources(input, options = {}) {
  const resolveRealpath = options.realpath ?? realpath;
  const targetCwd = await canonicalDirectory(input.targetCwd, resolveRealpath);
  const sourceCwd = input.sourceCwd
    ? await canonicalDirectory(input.sourceCwd, resolveRealpath)
    : null;
  const responseSources = await canonicalSources(
    input.instructionSources ?? [],
    resolveRealpath
  );
  const requiredTargetSources = await canonicalSources(
    input.requiredTargetSources ?? [],
    resolveRealpath
  );
  const globalSources = new Set(await canonicalSources(
    input.globalInstructionSources ?? [],
    resolveRealpath
  ));
  const requiredTargetSet = new Set(requiredTargetSources);
  const responseSet = new Set(responseSources);
  const missingTargetSources = requiredTargetSources.filter((path) => !responseSet.has(path));
  const staleSourceSources = responseSources.filter((path) => {
    // Locally shared Agent configuration is intentionally symlinked from each
    // worktree to the main workspace. Its realpath therefore points into the
    // source workspace even though the target explicitly requires that same
    // file. Required target provenance makes this source valid.
    if (globalSources.has(path)
      || requiredTargetSet.has(path)
      || isInstructionApplicableToWorkspace(path, targetCwd)) return false;
    return sourceCwd ? isWithin(path, sourceCwd) : true;
  });
  const unexpectedSources = responseSources.filter((path) => {
    return !globalSources.has(path)
      && !requiredTargetSet.has(path)
      && !isInstructionApplicableToWorkspace(path, targetCwd)
      && !staleSourceSources.includes(path);
  });
  const valid = missingTargetSources.length === 0
    && staleSourceSources.length === 0
    && unexpectedSources.length === 0;
  return {
    valid,
    targetCwd,
    sourceCwd,
    instructionSources: responseSources,
    requiredTargetSources,
    missingTargetSources,
    staleSourceSources,
    unexpectedSources
  };
}

export function permissionSnapshotFromAppServerResponse(response = {}) {
  return {
    cwd: response.cwd ?? response.thread?.cwd ?? null,
    runtimeWorkspaceRoots: response.runtimeWorkspaceRoots ?? [],
    approvalPolicy: response.approvalPolicy ?? null,
    approvalsReviewer: response.approvalsReviewer ?? null,
    sandboxPolicy: response.sandbox ?? response.thread?.sandboxPolicy ?? null,
    activePermissionProfile: response.activePermissionProfile ?? null
  };
}

export function workspaceTransitionContext(input) {
  const sources = (input.instructionSources ?? []).map((path) => `- ${path}`).join("\n");
  return [
    "Corptie workspace transition:",
    `- Active workspace: ${input.targetCwd}`,
    `- Previous workspace: ${input.sourceCwd}`,
    "- Treat the active workspace as the sole default target for subsequent file, Git, terminal, and diff operations.",
    "Instruction sources loaded for this workspace:",
    sources || "- (none)"
  ].join("\n");
}

async function canonicalDirectory(path, resolveRealpath) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`Workspace path must be absolute: ${path ?? ""}`);
  }
  return resolveRealpath(resolve(path));
}

async function canonicalSources(paths, resolveRealpath) {
  const canonical = [];
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`Instruction source path must be absolute: ${path ?? ""}`);
    }
    canonical.push(await resolveRealpath(resolve(path)));
  }
  return [...new Set(canonical)];
}

function isInstructionApplicableToWorkspace(instructionPath, workspacePath) {
  return isWithin(instructionPath, workspacePath)
    || isWithin(workspacePath, dirname(instructionPath));
}

function isWithin(path, ancestor) {
  const child = relative(ancestor, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
