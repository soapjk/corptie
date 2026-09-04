const validLeases = new WeakSet();

export function createValidatedSnapshotLease(snapshot, snapshotBuilder, options = {}) {
  const lease = Object.freeze({
    snapshot,
    sourceFingerprint: snapshot.receipt.sourceFingerprint,
    mode: options.mode ?? "full-validation",
    verifyBefore: options.verifyBefore ?? (() => true),
    verifyAfter: options.verifyAfter ?? ((verifyOptions = {}) => snapshotBuilder.assertCurrent(snapshot, verifyOptions))
  });
  validLeases.add(lease);
  return lease;
}

export function isValidatedSnapshotLease(value, snapshot) {
  return Boolean(value && validLeases.has(value) && value.snapshot === snapshot
    && value.sourceFingerprint === snapshot?.receipt?.sourceFingerprint);
}
