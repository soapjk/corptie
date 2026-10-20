// Business resource eligibility only. Native clients own card layout/style.
export const NATIVE_BUSINESS_MODULES = Object.freeze(["focusTasks", "references", "artifacts", "memories", "memoryHits", "schedules", "provider", "turn", "worktree"]);
export function eligibleNativeBusinessModules(scope) {
  const kind = scope.session.sessionKind;
  if (!["assistantChat", "workChat", "worker"].includes(kind)) return [];
  return NATIVE_BUSINESS_MODULES.filter(name => {
    if (name === "focusTasks") return kind === "workChat" && Boolean(scope.work);
    if (name === "artifacts") return kind !== "assistantChat" && Boolean(scope.work);
    if (name === "memories") return kind !== "assistantChat" && Boolean(scope.task || scope.work);
    // Worktree applicability is decided by the actual status reader result,
    // never inferred from a Work id, Provider name or Session display label.
    return true;
  });
}
