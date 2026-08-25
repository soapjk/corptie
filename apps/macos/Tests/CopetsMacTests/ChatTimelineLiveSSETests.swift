import XCTest
import Darwin
@testable import CorptieMac

@MainActor
final class ChatTimelineLiveSSETests: XCTestCase {
    func testRapidSelectionKeepsOnlyLatestStreamGeneration() async throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_RUN_LIVE_SSE_TEST"] == "1" else {
            throw XCTSkip("Set CORPTIE_RUN_LIVE_SSE_TEST=1 with the Development backend running.")
        }
        let client = BackendClient()
        client.start()
        defer { client.stop() }

        try await eventually(stage: { "load sessions for rapid switching" }, timeout: .seconds(8)) {
            client.sessions.count >= 2
        }
        let first = client.sessions[0]
        let second = client.sessions[1]
        for index in 0..<20 {
            client.select(session: index.isMultiple(of: 2) ? first : second)
            await Task.yield()
        }
        let expected = second
        let expectedThreadID = expected.external?.threadId ?? expected.id
        try await eventually(stage: { "latest rapid selection (expected.id)" }, timeout: .seconds(8)) {
            client.selectedSession?.id == expected.id
                && client.selectedDetail?.id == expectedThreadID
                && SessionTimelineRepository.shared.detail(for: expected.id)?.id == expectedThreadID
                && client.detailStreamHealth == .healthy(sessionId: expected.id)
        }
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(client.selectedSession?.id, expected.id)
        XCTAssertEqual(client.selectedDetail?.id, expectedThreadID)
        XCTAssertEqual(SessionTimelineRepository.shared.detail(for: expected.id)?.id, expectedThreadID)
        XCTAssertEqual(client.detailStreamHealth, .healthy(sessionId: expected.id))
    }

    func testDevelopmentBackendStreamSuppressesPollingAndRecovers() async throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_RUN_LIVE_SSE_TEST"] == "1" else {
            throw XCTSkip("Set CORPTIE_RUN_LIVE_SSE_TEST=1 with the Development backend running.")
        }
        let client = BackendClient()
        ChatPerformanceRecorder.shared.reset()
        client.start()
        defer { client.stop() }

        try await eventually(stage: { "load sessions" }, timeout: .seconds(8)) { !client.sessions.isEmpty }
        let first = try XCTUnwrap(client.sessions.first)
        client.select(session: first)
        try await eventually(
            stage: { "first stream \(first.id), health=\(client.detailStreamHealth), detail=\(client.selectedDetail?.id ?? "nil"), error=\(client.lastError ?? "nil"), diagnostic=\(client.detailStreamLastDiagnostic)" },
            timeout: .seconds(8)
        ) {
            client.detailStreamHealth == .healthy(sessionId: first.id)
                && client.selectedDetail != nil
                && SessionTimelineRepository.shared.detail(for: first.id)?.id == client.selectedDetail?.id
                && client.detailTimelineRevision != nil
        }

        let before = ChatPerformanceRecorder.shared.snapshot()[.detailPollRequests]
        try await Task.sleep(for: .seconds(5))
        let after = ChatPerformanceRecorder.shared.snapshot()[.detailPollRequests]
        XCTAssertEqual(after, before)

        client.stop()
        XCTAssertEqual(client.detailStreamHealth, .inactive)
        client.start()
        try await eventually(stage: { "recovered stream \(first.id)" }, timeout: .seconds(8)) {
            client.detailStreamHealth == .healthy(sessionId: first.id)
        }

        if let second = client.sessions.first(where: { $0.id != first.id }) {
            client.select(session: second)
            try await eventually(stage: { "switched stream \(second.id)" }, timeout: .seconds(8)) {
                client.selectedSession?.id == second.id
                    && client.detailStreamHealth == .healthy(sessionId: second.id)
                    && client.selectedDetail != nil
                    && SessionTimelineRepository.shared.detail(for: second.id)?.id == client.selectedDetail?.id
            }
            try await Task.sleep(for: .seconds(1))
            XCTAssertEqual(client.selectedSession?.id, second.id)
            XCTAssertEqual(client.detailStreamHealth, .healthy(sessionId: second.id))
        }
    }

    func testDevelopmentBackendProcessRestartRecoversSelectedStream() async throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_RUN_LIVE_SSE_RESTART_TEST"] == "1" else {
            throw XCTSkip("Set CORPTIE_RUN_LIVE_SSE_RESTART_TEST=1 to allow restarting the Development backend.")
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

        try await eventually(stage: { "load sessions before backend restart" }, timeout: .seconds(8)) {
            !client.sessions.isEmpty
        }
        let session = try XCTUnwrap(client.sessions.first)
        client.select(session: session)
        try await eventually(stage: {
            "initial healthy stream before backend restart: health=\(client.detailStreamHealth), diagnostic=\(client.detailStreamLastDiagnostic), error=\(client.lastError ?? "nil")"
        }, timeout: .seconds(8)) {
            client.detailStreamHealth == .healthy(sessionId: session.id)
        }
        let detailIDBeforeRestart = client.selectedDetail?.id

        let listenerPID = try developmentBackendListenerPID()
        XCTAssertEqual(Darwin.kill(listenerPID, SIGTERM), 0)
        try await eventually(stage: { "stream fallback after backend termination" }, timeout: .seconds(8)) {
            !client.detailStreamHealth.isHealthy(for: session.id)
        }

        replacementBackend = try startDevelopmentBackend()
        try await eventually(stage: { "Development backend health after restart" }, timeout: .seconds(15)) {
            Self.developmentBackendIsHealthy()
        }
        try await eventually(
            stage: { "healthy selected stream after backend restart: \(client.detailStreamLastDiagnostic)" },
            timeout: .seconds(20)
        ) {
            client.detailStreamHealth == .healthy(sessionId: session.id)
                && client.selectedDetail?.id == detailIDBeforeRestart
        }
    }

    private func eventually(
        stage: @escaping @MainActor () -> String,
        timeout: Duration,
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
        let logURL = URL(fileURLWithPath: "/private/tmp/corptie-dev/backend-restart-test.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        process.standardOutput = try FileHandle(forWritingTo: logURL)
        process.standardError = process.standardOutput
        try process.run()
        return process
    }

    nonisolated private static func developmentBackendIsHealthy() -> Bool {
        guard let data = try? Data(contentsOf: URL(string: "http://127.0.0.1:47322/health")!) else {
            return false
        }
        return String(data: data, encoding: .utf8)?.contains("\"ok\":true") == true
    }
}
