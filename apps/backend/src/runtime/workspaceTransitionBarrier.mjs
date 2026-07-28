export function workspaceTransitionBlocksWork(logicalSession) {
  return Boolean(logicalSession?.transitionState);
}

export function resumeWorkAfterTransition(continuation, resume) {
  if (!continuation) {
    resume();
    return null;
  }
  return Promise.resolve(continuation).finally(resume);
}
