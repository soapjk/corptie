// Public bootstrap contract. Never include paths, credentials, Provider config, or user data.
export function clientCapabilities() {
  return {
    schemaVersion: 1,
    service: "corptie",
    connection: { mode: "local-only", deviceAuthentication: false, remoteAccess: false },
    synchronization: { stateSnapshot: true, stateChanges: true, stateEvents: true, timelineWindow: true },
    resources: { portableFileAccess: false },
  };
}
