import Foundation
import Testing
import CorptieClientCore
import CorptieClientSecurity
@testable import CorptieMobileState

@MainActor struct PadConnectionRecoveryTests {
    @Test func foregroundRecoveryReplacesSubscriptionWithoutLosingDraftOrMessages() async throws {
        let probe = RecoveryProbe()
        let connection = PadConnection(cloudTargetMacID: UUID(), relayFactory: { _ in try await probe.make() })
        connection.connected = true
        let workspace = PadWorkspace()
        workspace.selection = "session:kept"
        workspace.drafts["session:kept"] = "unsent draft"
        workspace.messages = try JSONDecoder().decode([ClientMessage].self,
            from: Data(#"[{"id":"kept","type":"userMessage","text":"existing history"}]"#.utf8))
        let first = Task { await workspace.runRealtime(connection) }
        for _ in 0..<50 {
            if workspace.realtimeConnected { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(workspace.realtimeConnected)
        workspace.prepareForegroundRealtime()
        connection.requestRealtimeRecovery()
        first.cancel(); await first.value
        let resumed = Task { await workspace.runRealtime(connection) }
        for _ in 0..<50 {
            if workspace.realtimeConnected { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(workspace.realtimeConnected)
        #expect(!workspace.realtimeReconnectFailed)
        #expect(workspace.selection == "session:kept")
        #expect(workspace.drafts["session:kept"] == "unsent draft")
        #expect(workspace.messages.first?.id == "kept")
        #expect(probe.channels.count == 2)
        for channel in probe.channels { #expect(await channel.methods.allSatisfy { $0 == "GET" }) }
        resumed.cancel(); await resumed.value
        connection.disconnect()
    }

    @Test func concurrentReadsShareOneRecoveryAndDeadChannelIsReplaced() async throws {
        let probe = RecoveryProbe()
        let connection = PadConnection(cloudTargetMacID: UUID(), relayFactory: { _ in try await probe.make() })
        connection.connected = true
        async let first = connection.transport()
        async let second = connection.transport()
        let (a, b) = try await (first, second)
        #expect(a === b)
        #expect(probe.channels.count == 1)
        await probe.channels[0].close()
        for _ in 0..<30 {
            if !(await probe.clients[0].isUsable()) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let fresh = try await connection.transport()
        #expect(fresh !== a)
        #expect(probe.channels.count == 2)
        let cached = try await connection.transport()
        #expect(cached === fresh)
        for channel in probe.channels { #expect(await channel.methods.allSatisfy { $0 == "GET" }) }
        connection.disconnect()
    }

    @Test func lateRecoveryCannotOverwriteNewConnectionOrReviveExplicitDisconnect() async throws {
        let probe = RecoveryProbe()
        probe.holdFirst = true
        let connection = PadConnection(cloudTargetMacID: UUID(), relayFactory: { _ in try await probe.make() })
        connection.connected = true
        let old = Task { try await connection.transport() }
        for _ in 0..<30 {
            if probe.gate != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        connection.requestRealtimeRecovery()
        let fresh = try await connection.transport()
        probe.gate?.resume(); probe.gate = nil
        do { _ = try await old.value; Issue.record("Old recovery must be cancelled") }
        catch { #expect(error is CancellationError) }
        let cached = try await connection.transport()
        #expect(cached === fresh)
        connection.disconnect()
        await #expect(throws: ClientConnectionError.invalidCredential) { try await connection.transport() }
        let revision = connection.recoveryRevision
        connection.requestRealtimeRecovery()
        #expect(connection.recoveryRevision == revision)
    }

    @Test func networkChangesCoalesceAndOfflinePausesRecovery() async throws {
        let connection = PadConnection()
        connection.connected = true
        connection.applyNetworkPath(.init(available: true, interfaces: "wifi"))
        #expect(connection.recoveryRevision == 0)
        connection.applyNetworkPath(.init(available: true, interfaces: "cellular"))
        connection.applyNetworkPath(.init(available: true, interfaces: "wifi"))
        connection.applyNetworkPath(.init(available: true, interfaces: "cellular"))
        // The full suite shares the main actor. Wait for the observable result,
        // not 100 ms of assumed scheduling headroom above the 250 ms debounce.
        for _ in 0..<200 where connection.recoveryRevision == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(connection.recoveryRevision == 1)
        connection.applyNetworkPath(.init(available: true, interfaces: "cellular"))
        #expect(connection.recoveryRevision == 1)
        connection.applyNetworkPath(.init(available: false, interfaces: ""))
        #expect(!connection.networkAvailable)
        #expect(connection.connectionStatusNotice(reconnectFailed: false) == "网络不可用")
        let workspace = PadWorkspace()
        await workspace.runRealtime(connection)
        #expect(!workspace.realtimeReconnectFailed)
        connection.applyNetworkPath(.init(available: true, interfaces: "cellular"))
        for _ in 0..<200 where connection.recoveryRevision < 3 {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(connection.networkAvailable)
        #expect(connection.recoveryRevision == 3)
        #expect(connection.connectionStatusNotice(reconnectFailed: false) == nil)
        connection.disconnect()
    }

    @Test func authorizationFailureStopsNetworkTriggeredRetriesAndBackoffIsBounded() {
        let connection = PadConnection()
        connection.connected = true
        #expect(connection.stopRecoveryIfUnauthorized(ClientConnectionError.httpStatus(401)))
        connection.requestRealtimeRecovery()
        #expect(connection.recoveryRevision == 0)
        #expect(connection.connectionStatusNotice(reconnectFailed: false)?.contains("授权") == true)
        #expect(!connection.stopRecoveryIfUnauthorized(URLError(.timedOut)))
        #expect(PadConnection.recoveryDelay(failures: 1) == .seconds(1))
        #expect(PadConnection.recoveryDelay(failures: 2) == .seconds(2))
        #expect(PadConnection.recoveryDelay(failures: 100) == .seconds(15))
        #expect(PadConnection.recoveryDelay(failures: 100, jitter: 1.15) == .seconds(15))
    }
}

@MainActor private final class RecoveryProbe {
    var channels: [RecoveryChannel] = []
    var clients: [CloudRelayHTTPClient] = []
    var holdFirst = false
    var gate: CheckedContinuation<Void, Never>?
    private var attempts = 0
    func make() async throws -> CloudRelayHTTPClient {
        attempts += 1
        if attempts == 1 && holdFirst {
            // Deliberately ignores cancellation to exercise stale-result isolation.
            await withCheckedContinuation { gate = $0 }
        } else { try await Task.sleep(for: .milliseconds(20)) }
        let channel = RecoveryChannel()
        let relay = CloudRelayHTTPClient(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!), channel: channel)
        channels.append(channel); clients.append(relay)
        return relay
    }
}

private actor RecoveryChannel: CloudRelaySecureChannel {
    private(set) var methods: [String] = []
    private var responses: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var closed = false
    func send(_ plaintext: Data) async throws {
        guard !closed else { throw CloudRelayTransportError.disconnected }
        let message = try JSONDecoder().decode(CloudRelayApplicationMessage.self, from: plaintext)
        guard message.kind == .request else { return }
        methods.append(message.method!)
        let streaming = message.path?.contains("/events") == true
        enqueue(try JSONEncoder().encode(CloudRelayApplicationMessage.response(id: message.id, status: 200,
            headers: streaming ? ["Content-Type": "text/event-stream"] : [:])))
        let body = streaming
            ? "event: stream-ready\ndata: {\"schemaVersion\":2,\"pushPayloads\":true,\"eventRecovery\":\"snapshot\"}\n\n"
            : "{}"
        enqueue(try JSONEncoder().encode(CloudRelayApplicationMessage.chunk(id: message.id,
            body: Data(body.utf8), final: !streaming)))
    }
    func receive() async throws -> Data {
        guard !closed else { throw CloudRelayTransportError.disconnected }
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func close() async {
        closed = true
        waiter?.resume(throwing: CloudRelayTransportError.disconnected); waiter = nil
    }
    private func enqueue(_ data: Data) {
        if let waiter { self.waiter = nil; waiter.resume(returning: data) }
        else { responses.append(data) }
    }
}
