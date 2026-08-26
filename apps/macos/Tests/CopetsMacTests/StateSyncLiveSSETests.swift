import Darwin
import XCTest
@testable import CorptieMac

/// Opt-in process test for the canonical global State Sync stream. This is not
/// the deleted selected-Timeline SSE protocol: active Timelines are warmed from
/// durable revisions, while one global stream owns Session status and reconnect.
@MainActor
final class StateSyncLiveSSETests: XCTestCase {
    func testDevelopmentBackendRestartRecoversGlobalStateWithoutLosingSelectionOrTimelineCache() async throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_RUN_STATE_SYNC_RESTART_TEST"] == "1" else {
            throw XCTSkip("Set CORPTIE_RUN_STATE_SYNC_RESTART_TEST=1 to allow restarting the Development backend.")
        }

        let client = BackendClient()
        client.start()
        var replacementBackend: Process?
        defer {
            client.stop()
            if replacementBackend == nil {
                replacementBackend = try? startDevelopmentBackend()
            }
        }

        try await eventually(stage: { "initial global State Sync; online=\(client.isOnline), sessions=\(client.sessions.count), error=\(client.lastError ?? "nil")" }) {
            client.isOnline && !client.sessions.isEmpty
        }
        let session = try XCTUnwrap(client.sessions.first)
        client.select(session: session)
        try await eventually(stage: { "active Timeline warm before restart; selected=\(client.selectedSession?.id ?? "nil"), cached=\(SessionTimelineRepository.shared.detail(for: session.id)?.id ?? "nil")" }) {
            client.selectedSession?.id == session.id
                && SessionTimelineRepository.shared.detail(for: session.id) != nil
        }
        let revisionBeforeRestart = AppStateStore.shared.revision
        let cachedTimelineID = SessionTimelineRepository.shared.detail(for: session.id)?.id

        let listenerPID = try developmentBackendListenerPID()
        XCTAssertEqual(Darwin.kill(listenerPID, SIGTERM), 0)
        try await eventually(stage: { "transport reports backend termination; online=\(client.isOnline), error=\(client.lastError ?? "nil")" }) {
            !client.isOnline
        }

        replacementBackend = try startDevelopmentBackend()
        try await eventually(stage: {
            "global State Sync reconnect; online=\(client.isOnline), revision=\(AppStateStore.shared.revision)/\(revisionBeforeRestart), selected=\(client.selectedSession?.id ?? "nil")/\(session.id), cached=\(SessionTimelineRepository.shared.detail(for: session.id)?.id ?? "nil")/\(cachedTimelineID ?? "nil"), error=\(client.lastError ?? "nil")"
        }, timeout: .seconds(25)) {
            client.isOnline
                && AppStateStore.shared.revision >= revisionBeforeRestart
                && client.selectedSession?.id == session.id
                && SessionTimelineRepository.shared.detail(for: session.id)?.id == cachedTimelineID
        }
    }

    private func eventually(
        stage: @escaping @MainActor () -> String,
        timeout: Duration = .seconds(12),
        condition: @escaping @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Condition did not become true before timeout: \(stage())")
        throw TestTimeout()
    }

    private struct TestTimeout: Error {}

    private func developmentBackendListenerPID() throws -> pid_t {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-tiTCP:47322", "-sTCP:LISTEN"]
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let value = String(data: data, encoding: .utf8)?.split(separator: "\n").first
        return try XCTUnwrap(value.flatMap { pid_t($0) })
    }

    private func startDevelopmentBackend() throws -> Process {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let process = Process()
        process.executableURL = repositoryRoot.appendingPathComponent("scripts/start-backend-development.sh")
        process.currentDirectoryURL = repositoryRoot
        var environment = ProcessInfo.processInfo.environment
        environment["CORPTIE_ENV"] = "development"
        environment["CORPTIE_BACKEND_PORT"] = "47322"
        process.environment = environment
        let logURL = URL(fileURLWithPath: "/private/tmp/corptie-dev/state-sync-restart-test.log")
        try FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        process.standardOutput = try FileHandle(forWritingTo: logURL)
        process.standardError = process.standardOutput
        try process.run()
        return process
    }
}
