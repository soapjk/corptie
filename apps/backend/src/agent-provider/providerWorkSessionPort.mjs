/**
 * Provider-neutral Work Session port. It owns the complete Provider-facing
 * startup lifecycle while product orchestration remains Provider agnostic.
 */
export class ProviderWorkSessionPort {
  constructor(options = {}) {
    this.create = options.createSession;
    this.workspaceBinding = options.workspaceBinding;
    this.activate = options.activateSession;
    this.compensate = options.compensateSession;
    if (typeof this.create !== "function" || !this.workspaceBinding
      || typeof this.activate !== "function" || typeof this.compensate !== "function") {
      throw new TypeError(
        "ProviderWorkSessionPort requires createSession(), workspaceBinding, activateSession(), and compensateSession()."
      );
    }
  }

  createSession(context) { return this.create(context); }
  bindWorkspace(session, worktree) {
    return this.workspaceBinding.bindWorkspace({ ...session, ...worktree });
  }
  inspectBinding(binding) { return this.workspaceBinding.inspectBinding(binding); }
  activateSession(binding) { return this.activate(binding); }
  compensateSession(binding) { return this.compensate(binding); }
}
