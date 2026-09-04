const validLeases = new WeakSet();

export function createValidatedSnapshotLease(snapshot, snapshotBuilder) {
  const lease = Object.freeze({
    snapshot,
    sourceFingerprint: snapshot.receipt.sourceFingerprint,
    verifyAfter: (options = {}) => snapshotBuilder.assertCurrent(snapshot, options)
  });
  validLeases.add(lease);
  return lease;
}

export function isValidatedSnapshotLease(value, snapshot) {
  return Boolean(value && validLeases.has(value) && value.snapshot === snapshot
    && value.sourceFingerprint === snapshot?.receipt?.sourceFingerprint);
}
