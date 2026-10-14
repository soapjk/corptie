import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailActionTests {
    @Test func desktopAndPairedAPIUseTheSameActionEnvelopeAndReceiptRoute() async throws {
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let prefix = route == .desktop ? "" : "/client/v1"
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
                #expect(request.value(forHTTPHeaderField: "Accept") == "application/json; corptie-detail=native-v1")
                #expect(request.url?.path.hasPrefix(prefix + "/sessions/logical:ours/detail/") == true)
                if request.httpMethod == "POST" {
                    let body = try JSONDecoder().decode(ClientDetailActionRequest.self, from: #require(request.httpBody))
                    #expect(body.requestId == "fixture-request-001")
                    #expect(body.fields["confirmed"] == .bool(true))
                } else { #expect(request.url?.path.hasSuffix("/receipts/fixture-request-001") == true) }
                let data = Data(#"{"schemaVersion":1,"requestId":"fixture-request-001","sessionId":"logical:ours","kind":"inspector:detail:schedule.cancel","status":"completed","updatedAt":"now"}"#.utf8)
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            let api = ClientDetailActionAPI(transport: transport, route: route)
            let body = ClientDetailActionRequest(requestId: "fixture-request-001", documentId: "doc", cardId: "card", actionId: "cancel", expectedResourceRevision: "7", fields: ["confirmed": .bool(true)])
            #expect(try await api.command(sessionID: Self.scope.sessionID, request: body).status == "completed")
            #expect(try await api.receipt(sessionID: Self.scope.sessionID, requestID: body.requestId).status == "completed")
        }
    }
    @Test func sharedActionFixtureDecodesWithFrozenEnvelopeAndNativeRoutes() throws {
        let url = try #require(Bundle.module.url(forResource: "detail-actions-v1", withExtension: "json", subdirectory: "Fixtures"))
        struct Fixture: Decodable {
            struct Item: Decodable { let action: ClientDetailAction; let fields: [String: ClientInspectorValue] }
            let operations: [Item]
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.operations.count == 9)
        for item in fixture.operations {
            try ClientDetailActionRequest(requestId: "fixture-request-001", documentId: "doc", cardId: "card", actionId: item.action.id,
                expectedResourceRevision: item.action.expectedResourceRevision, fields: item.fields).validate()
            if item.action.kind == "navigation" { _ = try ClientDetailActionRouting.target(for: item.action) }
        }
    }
    static let scope = ClientDetailActionScope(serverID: "server", principalID: "user", sessionID: "logical:ours",
        accountID: "account", credentialBindingID: "device-binding-1", catalog: "native-v2-components-1", capabilityDigest: "digest-1")
    actor Journal: ClientDetailActionJournal {
        var records: [ClientDetailPendingAction] = []
        var fail = false
        func pending(scope: ClientDetailActionScope) -> [ClientDetailPendingAction] { records.filter { $0.scope == scope } }
        func save(_ record: ClientDetailPendingAction) throws { if fail { throw URLError(.cannotWriteToFile) }; records.append(record) }
        func remove(scope: ClientDetailActionScope, requestID: String) { records.removeAll { $0.scope == scope && $0.requestID == requestID } }
        func clear(scope: ClientDetailActionScope) { records.removeAll { $0.scope == scope } }
        func setFail() { fail = true }
    }
    actor Probe: ClientDetailActionTransport {
        let journal: Journal
        var commands: [ClientDetailActionRequest] = []
        var lookups: [String] = []
        var reads = 0
        var mode = "completed"
        var confirmed = 0
        var phases: [ClientDetailActionPhase] = []
        init(_ journal: Journal) { self.journal = journal }
        func setMode(_ value: String) { mode = value }
        func confirm() -> Bool { confirmed += 1; return true }
        func phase(_ phase: ClientDetailActionPhase) { phases.append(phase) }
        func read(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientInspectorValue {
            reads += 1
            return .string("read")
        }
        func command(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientCommandReceipt {
            #expect(await journal.pending(scope: ClientDetailActionTests.scope).contains { $0.requestID == request.requestId })
            commands.append(request)
            try await Task.sleep(for: .milliseconds(40))
            if mode == "lost" || mode == "unknown" { throw URLError(.networkConnectionLost) }
            return try receiptValue(request.requestId, status: "completed")
        }
        func receipt(sessionID: String, requestID: String) throws -> ClientCommandReceipt {
            lookups.append(requestID)
            return try receiptValue(requestID, status: mode == "unknown" ? "unknown" : "completed")
        }
        private func receiptValue(_ id: String, status: String) throws -> ClientCommandReceipt {
            let value: [String: String] = ["requestId": id, "sessionId": "logical:ours", "kind": "inspector:detail:schedule.cancel", "status": status, "updatedAt": "now"]
            var fields = value.mapValues { ClientInspectorValue.string($0) }; fields["schemaVersion"] = .number(1)
            return try JSONDecoder().decode(ClientCommandReceipt.self, from: JSONEncoder().encode(ClientInspectorValue.object(fields)))
        }
    }
    func action(_ operation: String = "schedule.cancel", kind: String = "command") throws -> ClientDetailAction {
        try JSONDecoder().decode(ClientDetailAction.self, from: Data("""
        {"id":"cancel","kind":"\(kind)","operation":"\(operation)","label":{"fallback":"Cancel schedule A"},"available":true,"target":{"resourceType":"schedule","id":"schedule:ours"},"expectedResourceRevision":"7","confirmation":"none"}
        """.utf8))
    }
    @Test func nativeDispatchCapabilityRejectsUnregisteredCommandsBeforeShowingEnabledUI() throws {
        #expect(ClientDetailActionCoordinator.supports(try action("memory.update")))
        #expect(ClientDetailActionCoordinator.supports(try action("reference.add")))
        #expect(ClientDetailActionCoordinator.supports(try action("detail.collection.page", kind: "read")))
        #expect(!ClientDetailActionCoordinator.supports(try action("provider.switch")))
        #expect(!ClientDetailActionCoordinator.supports(try action("resource.open", kind: "navigation")))
    }
    func coordinator(_ journal: Journal, _ probe: Probe) -> ClientDetailActionCoordinator {
        ClientDetailActionCoordinator(scope: Self.scope, transport: probe, journal: journal,
            phaseChanged: { _, phase in await probe.phase(phase) })
    }
    @Test func doubleClickConfirmsOncePersistsBeforeSendAndSharesReceipt() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe), action = try action()
        async let first = coordinator.perform(documentID: "doc", cardID: "card", action: action, fields: ["confirmed": .bool(true)], confirm: { _ in await probe.confirm() })
        async let second = coordinator.perform(documentID: "doc", cardID: "card", action: action, confirm: { _ in await probe.confirm() })
        _ = try await (first, second)
        #expect(await probe.commands.count == 1)
        #expect(await probe.confirmed == 1)
        #expect(await probe.commands.first?.fields["confirmed"] == .bool(true))
        #expect(await journal.records.isEmpty)
    }
    @Test func lostResponseReconcilesOriginalIDWithoutResending() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe)
        await probe.setMode("lost")
        _ = try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in true })
        #expect(await probe.commands.count == 1)
        #expect(await probe.lookups == probe.commands.map(\.requestId))
        #expect(await journal.records.isEmpty)
    }
    @Test func unknownSurvivesRestartAndAllowsOnlyReceiptRecovery() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe)
        await probe.setMode("unknown")
        _ = try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in true })
        let restored = self.coordinator(journal, probe)
        _ = try await restored.recover()
        _ = try await restored.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in true })
        #expect(await probe.commands.count == 1)
        #expect(await probe.lookups.count == 3)
        #expect(await journal.records.count == 1)
    }
    @Test func failedPersistenceAndDeclinedConfirmationNeverSend() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe)
        let result = try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), fields: ["confirmed": .bool(true)], confirm: { _ in false })
        if case .cancelled = result {} else { Issue.record("Confirmation must be shown even if caller supplies true") }
        await journal.setFail()
        await #expect(throws: URLError.self) { _ = try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in true }) }
        #expect(await probe.commands.isEmpty)
    }
    @Test func pendingWriteDoesNotBlockReadAndRevocationCancelsLateResult() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe)
        let write = Task { try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in true }) }
        for _ in 0..<100 { if await probe.commands.count == 1 { break }; await Task.yield() }
        _ = try await coordinator.perform(documentID: "doc", cardID: "read", action: action("detail.refresh", kind: "read"), confirm: { _ in false })
        #expect(await probe.reads == 1)
        try await coordinator.invalidate()
        await #expect(throws: CancellationError.self) { _ = try await write.value }
        #expect(await journal.records.isEmpty)
        await #expect(throws: ClientServiceFailure.self) { _ = try await coordinator.recover() }
    }
    @Test func revokedIdentityDuringDeclinedConfirmationCannotPublishCancelledOrSend() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe)
        await #expect(throws: CancellationError.self) {
            _ = try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in
                try? await coordinator.invalidate()
                return false
            })
        }
        #expect(await probe.phases == [.confirming])
        #expect(await probe.commands.isEmpty)
        #expect(await journal.records.isEmpty)
    }
    @Test func cancellingDispatchedCommandDoesNotClaimCancellationOrRemoveRecoveryIdentity() async throws {
        let journal = Journal(), probe = Probe(journal), coordinator = coordinator(journal, probe)
        await probe.setMode("unknown")
        let write = Task { try await coordinator.perform(documentID: "doc", cardID: "card", action: action(), confirm: { _ in true }) }
        for _ in 0..<100 {
            if await probe.commands.count == 1 { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(await probe.commands.count == 1)
        #expect(await coordinator.cancel(documentID: "doc", cardID: "card", actionID: "cancel") == false)
        _ = try await write.value
        #expect(await journal.records.count == 1)
        #expect(await probe.phases.contains(.unknown))
        #expect(await probe.phases.contains(.cancelled) == false)
        #expect(await coordinator.cancel(documentID: "doc", cardID: "card", actionID: "cancel") == false)
        #expect(await journal.records.count == 1)
    }
    @Test func registeredNavigationReturnsOnlyNativeResourceDestination() throws {
        let valid = try action("resource.open", kind: "navigation")
        let resolver = ClientDetailActionRouting.Resolver(registrations: ["resource.open": ["schedule"]])
        #expect(try resolver.target(for: valid).resourceType == "schedule")
        #expect(throws: ClientServiceFailure.self) { try ClientDetailActionRouting.Resolver().target(for: valid) }
        let invalid = try action("https://untrusted", kind: "navigation")
        #expect(throws: ClientServiceFailure.self) { try resolver.target(for: invalid) }
    }
}
