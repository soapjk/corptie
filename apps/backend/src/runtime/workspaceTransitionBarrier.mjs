export function workspaceTransitionBlocksWork(logicalSession) {
  return new Set([
    "waitingForTurn",
    "preflighting",
    "forking",
    "validatingInstructions",
    "committingRoute"
  ]).has(logicalSession?.transitionState);
}

export function resumeWorkAfterTransition(continuation, resume) {
  if (!continuation) {
    resume();
    return null;
  }
  return Promise.resolve(continuation).finally(resume);
}
