export function collaborationWorkPresentation(store, { sourceWorkId, targetWorkId }) {
  const resolvedSourceWorkId = sourceWorkId ?? null;
  const resolvedTargetWorkId = targetWorkId ?? null;
  return {
    collaborationSourceWorkId: resolvedSourceWorkId,
    collaborationSourceWorkName: resolvedSourceWorkId
      ? store.getWork(resolvedSourceWorkId)?.name ?? null
      : null,
    collaborationTargetWorkId: resolvedTargetWorkId,
    collaborationTargetWorkName: resolvedTargetWorkId
      ? store.getWork(resolvedTargetWorkId)?.name ?? null
      : null
  };
}
