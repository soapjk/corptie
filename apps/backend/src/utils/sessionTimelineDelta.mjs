const protocolVersion = 1;

export function supportsTimelineDelta(headers = {}) {
  return String(headers["x-corptie-timeline-protocol"] ?? "") === String(protocolVersion);
}

export function createTimelineStreamState(session, revision = 1) {
  const fingerprints = itemFingerprints(session?.items);
  return {
    revision,
    metadataFingerprint: JSON.stringify(sessionMetadata(session)),
    itemFingerprints: fingerprints
  };
}

export function initialTimelineSnapshot(session, revision = 1) {
  const state = createTimelineStreamState(session, revision);
  return {
    state,
    event: {
      name: "snapshot",
      revision,
      data: { protocolVersion, revision, session }
    }
  };
}

export function nextTimelineEvent(previousState, nextSession, options = {}) {
  if (!previousState) return initialTimelineSnapshot(nextSession);
  if (options.fullConsistency === false) {
    return nextFastTimelineEvent(previousState, nextSession);
  }
  const metadata = sessionMetadata(nextSession);
  const metadataFingerprint = JSON.stringify(metadata);
  const nextItems = nextSession?.items ?? [];
  const nextFingerprints = itemFingerprints(nextItems);
  const previousFingerprints = previousState.itemFingerprints;
  const metadataUnchanged = previousState.metadataFingerprint === metadataFingerprint;
  const itemsUnchanged = previousFingerprints.length === nextFingerprints.length
    && previousFingerprints.every((fingerprint, index) => fingerprint === nextFingerprints[index]);
  if (metadataUnchanged && itemsUnchanged) {
    return { state: previousState, event: null };
  }

  const baseRevision = previousState.revision;
  const revision = baseRevision + 1;
  const commonCount = Math.min(previousFingerprints.length, nextFingerprints.length);
  const changedIndexes = [];
  for (let index = 0; index < commonCount; index += 1) {
    if (previousFingerprints[index] !== nextFingerprints[index]) {
      changedIndexes.push(index);
      if (changedIndexes.length > 1) break;
    }
  }

  let name;
  let data;
  if (changedIndexes.length === 0 && nextItems.length > previousFingerprints.length) {
    name = "items.appended";
    data = {
      protocolVersion,
      baseRevision,
      revision,
      metadata,
      items: nextItems.slice(previousFingerprints.length)
    };
  } else if (changedIndexes.length === 1 && nextItems.length === previousFingerprints.length) {
    const index = changedIndexes[0];
    name = "item.updated";
    data = {
      protocolVersion,
      baseRevision,
      revision,
      metadata,
      index,
      item: nextItems[index]
    };
  } else if (changedIndexes.length === 0 && nextItems.length === previousFingerprints.length) {
    name = "metadata.updated";
    data = { protocolVersion, baseRevision, revision, metadata };
  } else {
    return initialTimelineSnapshot(nextSession, revision);
  }

  return {
    state: { revision, metadataFingerprint, itemFingerprints: nextFingerprints },
    event: { name, revision, data }
  };
}

function nextFastTimelineEvent(previousState, nextSession) {
  const metadata = sessionMetadata(nextSession);
  const metadataFingerprint = JSON.stringify(metadata);
  const nextItems = nextSession?.items ?? [];
  const previousFingerprints = previousState.itemFingerprints;
  const baseRevision = previousState.revision;
  const revision = baseRevision + 1;

  if (nextItems.length < previousFingerprints.length) {
    return initialTimelineSnapshot(nextSession, revision);
  }

  if (nextItems.length > previousFingerprints.length) {
    if (previousFingerprints.length > 0) {
      const boundaryIndex = previousFingerprints.length - 1;
      if (JSON.stringify(nextItems[boundaryIndex]) !== previousFingerprints[boundaryIndex]) {
        return initialTimelineSnapshot(nextSession, revision);
      }
    }
    const appended = nextItems.slice(previousFingerprints.length);
    const appendedFingerprints = itemFingerprints(appended);
    return {
      state: {
        revision,
        metadataFingerprint,
        itemFingerprints: previousFingerprints.concat(appendedFingerprints)
      },
      event: {
        name: "items.appended",
        revision,
        data: { protocolVersion, baseRevision, revision, metadata, items: appended }
      }
    };
  }

  const tailIndex = nextItems.length - 1;
  if (tailIndex >= 0) {
    const tailFingerprint = JSON.stringify(nextItems[tailIndex]);
    if (tailFingerprint !== previousFingerprints[tailIndex]) {
      const nextFingerprints = previousFingerprints.slice();
      nextFingerprints[tailIndex] = tailFingerprint;
      return {
        state: { revision, metadataFingerprint, itemFingerprints: nextFingerprints },
        event: {
          name: "item.updated",
          revision,
          data: {
            protocolVersion,
            baseRevision,
            revision,
            metadata,
            index: tailIndex,
            item: nextItems[tailIndex]
          }
        }
      };
    }
  }

  if (metadataFingerprint !== previousState.metadataFingerprint) {
    return {
      state: { ...previousState, revision, metadataFingerprint },
      event: {
        name: "metadata.updated",
        revision,
        data: { protocolVersion, baseRevision, revision, metadata }
      }
    };
  }
  return { state: previousState, event: null };
}

export function sessionMetadata(session) {
  const { items: _items, rawStatus: _rawStatus, ...metadata } = session ?? {};
  return metadata;
}

export function legacyTimelineSnapshotFrame(session) {
  const { rawStatus: _rawStatus, ...canonicalSession } = session ?? {};
  return {
    signature: JSON.stringify(canonicalSession),
    payload: JSON.stringify({ session })
  };
}

function itemFingerprints(items) {
  return (items ?? []).map((item) => JSON.stringify(item));
}
