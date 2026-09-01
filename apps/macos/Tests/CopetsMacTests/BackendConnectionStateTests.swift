import Foundation
import Testing
@testable import CorptieMac

/// Authoritative connection-state transitions live in `AppStateStore.isReachable`,
/// flipped by the sync engine on every snapshot/change-set success or transport
/// failure. `BackendClient.isOnline` derives from it via a Combine sink so the
/// console footer and floating panel refresh without a tab switch or restart.
@MainActor
struct BackendConnectionStateTests {
    private func snapshot(revision: Int64) -> StateSnapshotEnvelope {
        .init(revision: revision, state: .init(
            sessions: [], tasks: [], objectives: [], agents: [], skills: [], repositories: [], integrationRuns: []
        ))
    }

    private func pumpRunLoop() {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    }

    @Test func startupWithReadyServerFlipsOnlineOnFirstSnapshot() {
        let store = AppStateStore()
        #expect(store.isReachable == false)
        #expect(store.syncError == nil)

        _ = store.apply(snapshot: snapshot(revision: 1))

        #expect(store.isReachable == true)
        #expect(store.syncError == nil)
    }

    @Test func delayedReadyRecoversAfterFailedFirstSnapshot() {
        let store = AppStateStore()

        // Launch race: backend not up yet.
        store.reportSyncError("Connection refused")
        #expect(store.isReachable == false)
        #expect(store.syncError == "Connection refused")

        // Backend comes up; the sync engine's retry succeeds.
        _ = store.apply(snapshot: snapshot(revision: 1))
        #expect(store.isReachable == true)
        #expect(store.syncError == nil)
    }

    @Test func realDisconnectClearsReachabilityWithoutFalseSuccess() {
        let store = AppStateStore()
        _ = store.apply(snapshot: snapshot(revision: 1))
        #expect(store.isReachable == true)

        // Server drops; the stream reports a transport error.
        store.reportSyncError("The network connection was lost")
        #expect(store.isReachable == false)
        #expect(store.syncError == "The network connection was lost")

        // A stale/duplicate snapshot must not resurrect the connection.
        #expect(store.apply(snapshot: snapshot(revision: 0)) == .duplicate)
        #expect(store.isReachable == false)
    }

    @Test func backendClientDerivesIsOnlineFromReachability() {
        let client = BackendClient()

        // The shared store may be left reachable by earlier suites; a subsequent
        // true→true apply would not re-emit and the sink would never fire, so
        // force a deterministic disconnected baseline first.
        AppStateStore.shared.reportSyncError("reset")
        pumpRunLoop()
        #expect(client.isOnline == false)

        // The shared store's revision may have been advanced by earlier tests,
        // so derive strictly-increasing revisions to guarantee a real apply.
        let base = AppStateStore.shared.revision

        _ = AppStateStore.shared.apply(snapshot: snapshot(revision: base + 1))
        pumpRunLoop()
        #expect(client.isOnline == true)

        AppStateStore.shared.reportSyncError("lost")
        pumpRunLoop()
        #expect(client.isOnline == false)
        #expect(client.lastError == "lost")

        _ = AppStateStore.shared.apply(snapshot: snapshot(revision: base + 2))
        pumpRunLoop()
        #expect(client.isOnline == true)
        #expect(client.lastError == nil)
    }

    @Test func sessionStreamConnectionReconcilesStaleErrorWithoutMaskingSyncFailure() {
        let client = BackendClient()
        client.recordProjectWorktreeActionError("Merge conflict in server.mjs")
        #expect(client.lastError != nil)

        client.markBackendConnectedFromSessionStream()
        #expect(client.lastError == nil)
        #expect(client.projectWorktreeActionError == "Merge conflict in server.mjs")
    }

    @Test func stateStreamHeartbeatExpiryUsesAConservativeWindow() {
        let start = Date(timeIntervalSince1970: 1_000)
        #expect(!StateStreamLivenessPolicy.hasExpired(
            lastActivityAt: start,
            now: start.addingTimeInterval(44.9)
        ))
        #expect(StateStreamLivenessPolicy.hasExpired(
            lastActivityAt: start,
            now: start.addingTimeInterval(45)
        ))
    }

    @Test func equalRevisionStreamReconnectRestoresReachabilityWithoutAStateFrame() {
        let store = AppStateStore()
        _ = store.apply(snapshot: snapshot(revision: 7))
        store.reportSyncError("connection lost")
        #expect(store.isReachable == false)

        // `/state/events?after=7` intentionally sends no duplicate payload.
        // The successful HTTP/SSE handshake itself must recover online state.
        store.reportStateStreamConnected()
        #expect(store.isReachable == true)
        #expect(store.syncError == nil)
        #expect(store.revision == 7)
    }
}
