import Foundation
import Testing
import CryptoKit
import CorptieClientCore
import CorptieClientSecurity
@testable import CorptieMobileState

@MainActor
struct PadSendReadinessTests {
    @Test func cancelledComposerReadDoesNotDropReplacementWhileLeaseIsHeld() async throws {
        let probe = ComposerReplacementProbe()
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:19302")!)
        let transport = BackendTransport(endpoint: endpoint, data: { try await probe.respond($0) },
            bytes: { _ in throw URLError(.cancelled) })
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        let suite = "composer-replacement-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session"
        workspace.capabilities = try SendReadinessProbe.capabilities()
        let first = Task { await workspace.configureComposer(connection) }
        await probe.waitForFirstRead()
        #expect(workspace.configuringComposer)
        first.cancel() // Fixture deliberately delays cancellation completion.
        workspace.messageRevision += 1
        var replacementEntered = false
        let replacement = Task {
            replacementEntered = true
            await workspace.configureComposer(connection)
        }
        while !replacementEntered { await Task.yield() }
        #expect(workspace.composerConfiguration == nil)
        // Also cancel a queued replacement: it must finish without needing the
        // network response, and must not cancel the live replacement's read.
        var cancelledEntered = false
        let cancelled = Task {
            cancelledEntered = true
            await workspace.configureComposer(connection)
        }
        while !cancelledEntered { await Task.yield() }
        cancelled.cancel()
        await cancelled.value
        await probe.releaseFirstRead()
        await first.value
        await replacement.value
        #expect(await probe.reads == 2)
        #expect(workspace.composerConfiguration?.currentModel == "replacement")
        #expect(!workspace.configuringComposer)
    }

    @Test(arguments: [false, true])
    func displayReadsCannotHoldSendOrInventoryBusy(fail: Bool) async throws {
        let probe = SendReadinessProbe()
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:19301")!)
        let transport = BackendTransport(endpoint: endpoint, data: { try await probe.respond($0) },
            bytes: { _ in throw URLError(.cancelled) })
        let connection = PadConnection(transportOverride: transport, credentials: .init(
            serverId: "server", deviceId: "device", accessToken: "fixture", refreshToken: "fixture",
            accessExpiresAt: .greatestFiniteMagnitude, refreshExpiresAt: .greatestFiniteMagnitude))
        connection.serverID = "server"; connection.connected = true
        let suite = "send-readiness-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let outbox = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let workspace = PadWorkspace(defaults: defaults, messageOutbox: outbox)
        workspace.selection = "session"
        // Capabilities and messages are available while both optional endpoints hang.
        await workspace.load(connection)
        #expect(workspace.capabilities?.send.available == true)
        #expect(workspace.composerConfiguration == nil)
        let presentation = Task { await workspace.loadPresentation(connection) }
        let inventory = Task { await workspace.inventory(connection) }
        await probe.waitUntilHeld(3)
        #expect(!connection.busy)
        #expect(workspace.sendControlEnabled(connection, sessionID: "session"))
        workspace.drafts["session"] = "ordinary"
        async let first: Void = workspace.command(connection, stop: false, expectedSessionID: "session")
        async let duplicate: Void = workspace.command(connection, stop: false, expectedSessionID: "session")
        _ = await (first, duplicate)
        await workspace.messageDeliveryLifetime.waitForCurrentWorker()
        #expect(await probe.sentTexts == ["ordinary"])
        #expect(workspace.drafts["session"] == "")
        // Quick reply and quick message share this path and preserve an unrelated draft.
        workspace.drafts["session"] = "keep this draft"
        await workspace.sendSuggestedReply(connection, sessionID: "session", text: "quick")
        await workspace.messageDeliveryLifetime.waitForCurrentWorker()
        #expect(await probe.sentTexts == ["ordinary", "quick"])
        #expect(workspace.drafts["session"] == "keep this draft")
        #expect(workspace.composerConfiguration == nil)
        #expect(workspace.selectedSessionUsage == nil)
        if !fail {
            await probe.releaseUsage()
            for _ in 0..<100 where workspace.selectedSessionUsage == nil { await Task.yield() }
            #expect(workspace.selectedSessionUsage != nil)
            #expect(workspace.composerConfiguration == nil, "usage publishes before the held model response")
        }
        // Old UI callbacks, denied capability and revoked identity fail closed.
        workspace.selection = "other"
        await workspace.command(connection, stop: false, expectedSessionID: "session")
        await workspace.sendSuggestedReply(connection, sessionID: "session", text: "stale")
        workspace.selection = "session"
        connection.recoveryBlockedMessage = "revoked"
        await workspace.command(connection, stop: false)
        connection.recoveryBlockedMessage = nil
        connection.connected = false
        await workspace.sendSuggestedReply(connection, sessionID: "session", text: "disconnected")
        connection.connected = true
        workspace.capabilities = try SendReadinessProbe.capabilities(available: false)
        await workspace.command(connection, stop: false)
        #expect(workspace.drafts["session"] == "keep this draft")
        #expect(await probe.sentTexts == ["ordinary", "quick"])
        // Late successful/failed display responses are harmless after navigation.
        workspace.selectSession(from: "session", to: "other")
        workspace.selection = "other"
        await probe.release(fail: fail)
        await presentation.value
        await inventory.value
        #expect(workspace.composerConfiguration == nil)
        #expect(workspace.selectedSessionUsage == nil)
        #expect(workspace.drafts["session"] == "keep this draft")
    }
}

private actor SendReadinessProbe {
    var sentTexts: [String] = []
    private var gates: [(String, CheckedContinuation<Bool, Never>)] = []
    private var watchers: [(Int, CheckedContinuation<Void, Never>)] = []
    static func capabilities(available: Bool = true) throws -> ClientSessionCapabilities {
        try JSONDecoder().decode(ClientSessionCapabilities.self, from: capabilitiesData(available))
    }
    private static func capabilitiesData(_ available: Bool) -> Data {
        Data("""
        {"schemaVersion":1,"sessionId":"session","readMessages":true,"composer":true,"send":{"available":\(available)},"stop":{"available":false},"reliableMessages":{"version":1,"maximumAgeSeconds":604800,"messageIdentityVersion":2}}
        """.utf8)
    }
    func waitUntilHeld(_ count: Int) async {
        if gates.count >= count { return }
        await withCheckedContinuation { watchers.append((count, $0)) }
    }
    func release(fail: Bool) {
        let current = gates; gates = []
        for gate in current { gate.1.resume(returning: fail) }
    }
    func releaseUsage() {
        let ready = gates.filter { $0.0.hasSuffix("/usage") }
        gates.removeAll { $0.0.hasSuffix("/usage") }
        ready.forEach { $0.1.resume(returning: false) }
    }
    func respond(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let held = path.hasSuffix("/composer") || path.hasSuffix("/usage") || path.hasSuffix("/works")
        if held {
            let fail = await withCheckedContinuation { continuation in
                gates.append((path, continuation))
                let ready = watchers.filter { gates.count >= $0.0 }
                watchers.removeAll { gates.count >= $0.0 }
                ready.forEach { $0.1.resume() }
            }
            if fail { throw ClientServiceFailure(statusCode: 503, code: "DISPLAY_UNAVAILABLE") }
        }
        let data: Data
        if path.hasSuffix("/capabilities") { data = Self.capabilitiesData(true) }
        else if path.hasSuffix("/me") { data = Data(#"{"deviceId":"device","serverId":"server"}"#.utf8) }
        else if path.hasSuffix("/message-deliveries") {
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            sentTexts.append(body["text"] as! String)
            let id = body["requestId"] as! String
            data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "sessionId": "session",
                "requestId": id, "kind": "send", "status": "accepted", "updatedAt": "now",
                "messageId": ClientSessionAPI.messageID(deviceID: "device", requestID: id)])
        } else if path.hasSuffix("/messages") {
            data = Data(#"{"schemaVersion":1,"sessionId":"session","items":[],"hasEarlier":false,"revision":1}"#.utf8)
        } else if path.hasSuffix("/usage") {
            data = Data(#"{"schemaVersion":1,"sessionId":"session"}"#.utf8)
        } else if path.hasSuffix("/composer") {
            data = Data(#"{"schemaVersion":1,"sessionId":"session","models":[],"switchModel":{"available":true},"switchReasoning":{"available":true}}"#.utf8)
        } else { data = Data(#"{"schemaVersion":1,"items":[],"hasMore":false}"#.utf8) }
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

/// The first response ignores cancellation until explicitly released. This
/// deterministically exercises the old-reader/new-view-task overlap.
private actor ComposerReplacementProbe {
    var reads = 0
    private var held: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?
    func waitForFirstRead() async {
        if reads > 0 { return }
        await withCheckedContinuation { started = $0 }
    }
    func releaseFirstRead() { held?.resume(); held = nil }
    func respond(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        reads += 1
        let index = reads
        if index == 1 {
            await withCheckedContinuation { continuation in
                held = continuation
                started?.resume(); started = nil
            }
        }
        let model = index == 1 ? "stale" : "replacement"
        let data = Data("""
        {"schemaVersion":1,"sessionId":"session","currentModel":"\(model)","models":[],"switchModel":{"available":true},"switchReasoning":{"available":true}}
        """.utf8)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
