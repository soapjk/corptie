import { readFile } from "node:fs/promises";

export class ProjectToolsetInitializer {
  constructor(options) {
    this.manager = options.manager;
    this.backgroundAgent = options.backgroundAgent;
    this.referencePath = options.referencePath;
    this.onEvent = options.onEvent ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.activeByRepository = new Map();
    this.recoveredRepositories = new Set();
    this.lastErrorByRepository = new Map();
  }

  schedule(workingDirectory, options = {}) {
    void this.initialize(workingDirectory, options).catch((error) => {
      void this.manager.inspect(workingDirectory).then((state) => {
        this.lastErrorByRepository.set(state.repositoryId, error.message);
      }).catch(() => {});
      this.onEvent("ProjectToolsetInitializationFailed", {
        workingDirectory,
        error: error.message
      });
    });
  }

  async recoverOnce(workingDirectory) {
    const state = await this.manager.inspect(workingDirectory);
    if (state.configured || state.requiresUpdate || this.recoveredRepositories.has(state.repositoryId)) return false;
    this.recoveredRepositories.add(state.repositoryId);
    this.schedule(workingDirectory, { recovery: true });
    return true;
  }

  status(repositoryId) {
    if (this.activeByRepository.has(repositoryId)) {
      return { state: "configuring", error: null };
    }
    const error = this.lastErrorByRepository.get(repositoryId) ?? null;
    return error
      ? { state: "configurationFailed", error }
      : { state: "notConfigured", error: null };
  }

  async initialize(workingDirectory, options = {}) {
    const initial = await this.manager.inspect(workingDirectory);
    if (initial.configured && !options.force) {
      return { status: "ready", skipped: true, toolset: initial };
    }
    const active = this.activeByRepository.get(initial.repositoryId);
    if (active) return active;
    this.lastErrorByRepository.delete(initial.repositoryId);

    const operation = this.runInitialization(workingDirectory, options)
      .finally(() => this.activeByRepository.delete(initial.repositoryId));
    this.activeByRepository.set(initial.repositoryId, operation);
    return operation;
  }

  async runInitialization(workingDirectory, options) {
    const toolset = await this.manager.scaffold(workingDirectory, {
      unconfigure: options.force === true
    });
    const protocol = await readFile(this.referencePath, "utf8");
    this.onEvent("ProjectToolsetInitializationStarted", {
      repositoryId: toolset.repositoryId,
      mainPath: toolset.mainPath,
      toolsetPath: toolset.toolsetPath,
      update: options.force === true,
      recovery: options.recovery === true
    });

    if (!this.backgroundAgent) {
      throw new Error("ProjectToolsetInitializer requires a Background Agent Service.");
    }
    const result = await this.backgroundAgent.run({
      purpose: "project-toolset-initialization",
      cwd: toolset.toolsetPath,
      allowedRoots: [toolset.toolsetPath],
      permissionProfile: "workspace-write",
      developerInstructions: initializerInstructions(toolset),
      prompt: initializerPrompt(toolset, protocol, options.force === true),
      timeoutMs: this.timeoutMs
    });

    const completed = await this.manager.inspect(toolset.mainPath);
    if (!completed.configured) {
      throw new Error("The project-toolset Agent finished without marking the toolset configured.");
    }
    this.onEvent("ProjectToolsetInitializationCompleted", {
      repositoryId: completed.repositoryId,
      mainPath: completed.mainPath,
      toolsetPath: completed.toolsetPath
    });
    this.lastErrorByRepository.delete(completed.repositoryId);
    return {
      status: "ready",
      skipped: false,
      toolset: completed,
      operationId: result.operationId,
      providerId: result.providerId
    };
  }
}

function initializerInstructions(toolset) {
  return [
    "You are Corptie's one-time project-toolset initializer, not the user's ordinary development Agent.",
    `You may write only inside ${toolset.toolsetPath}.`,
    `The project to inspect read-only is ${toolset.mainPath}.`,
    "Do not modify tracked files, Git history, branches, worktrees, remotes, services, or external resources.",
    "Do not start, restart, or stop the project service during initialization.",
    "Do not use collaboration, subagents, skills, connectors, web access, or external uploads."
  ].join(" ");
}

function initializerPrompt(toolset, protocol, force) {
  return [
    force
      ? "Update the existing Corptie Scripts Tools Set to the current protocol. Preserve correct project-specific behavior."
      : "Configure the newly scaffolded Corptie Scripts Tools Set for this project.",
    `Project root (read-only): ${toolset.mainPath}`,
    `Toolset root (the only writable directory): ${toolset.toolsetPath}`,
    "Inspect project manifests, documentation, and existing local start scripts to determine the correct adapters.",
    "Follow this protocol exactly:",
    "<corptie_project_toolset_protocol>",
    protocol,
    "</corptie_project_toolset_protocol>"
  ].join("\n\n");
}
