import Foundation

public struct ClientDetailActionScope: Codable, Hashable, Sendable {
    public let serverID: String
    public let principalID: String
    public let sessionID: String
    public let accountID: String
    public let credentialBindingID: String
    public let catalog: String
    public let capabilityDigest: String
    public init(serverID: String, principalID: String, sessionID: String, accountID: String,
                credentialBindingID: String, catalog: String, capabilityDigest: String) {
        self.serverID = serverID; self.principalID = principalID; self.sessionID = sessionID
        self.accountID = accountID; self.credentialBindingID = credentialBindingID
        self.catalog = catalog; self.capabilityDigest = capabilityDigest
    }
    public var isValid: Bool {
        [serverID, principalID, sessionID, accountID, credentialBindingID, catalog, capabilityDigest]
            .allSatisfy { !$0.isEmpty && $0.utf8.count <= 1024 }
    }
}

/// Only recovery identity is persisted. No draft fields, credentials or second
/// receipt schema: all authoritative outcomes remain ClientCommandReceipt.
public struct ClientDetailPendingAction: Codable, Equatable, Sendable {
    public let scope: ClientDetailActionScope
    public let requestID: String
    public let documentID: String
    public let cardID: String
    public let actionID: String
    public let operation: String
    public let createdAt: Date
    public init(scope: ClientDetailActionScope, requestID: String, documentID: String, cardID: String,
                actionID: String, operation: String, createdAt: Date = Date()) {
        self.scope = scope; self.requestID = requestID; self.documentID = documentID; self.cardID = cardID
        self.actionID = actionID; self.operation = operation; self.createdAt = createdAt
    }
}

public protocol ClientDetailActionJournal: Sendable {
    func pending(scope: ClientDetailActionScope) async throws -> [ClientDetailPendingAction]
    func save(_ pending: ClientDetailPendingAction) async throws
    func remove(scope: ClientDetailActionScope, requestID: String) async throws
    func clear(scope: ClientDetailActionScope) async throws
}

public enum ClientDetailActionPhase: String, Sendable {
    case confirming, submitting, reading, reconciling, completed, rejected, unknown, failed, cancelled
}
public enum ClientDetailActionOutcome: Sendable {
    case read(ClientInspectorValue), receipt(ClientCommandReceipt), navigation(ClientDetailAction.Target), cancelled
}
public struct ClientDetailActionUncertain: Error, Sendable {
    public let requestID: String
    public let cause: any Error
}

/// One coordinator per authenticated scope; the host discards it on account or
/// server change. Each flight updates only its action through the phase callback.
public actor ClientDetailActionCoordinator {
    public typealias Confirmation = @Sendable (ClientDetailAction) async -> Bool
    public typealias PhaseChange = @Sendable (String, ClientDetailActionPhase) async -> Void
    private struct Key: Hashable { let document: String; let card: String; let action: String }
    private let scope: ClientDetailActionScope
    private let transport: any ClientDetailActionTransport
    private let journal: any ClientDetailActionJournal
    private let navigation: ClientDetailActionRouting.Resolver
    private let changed: PhaseChange
    private var flights: [Key: Task<ClientDetailActionOutcome, Error>] = [:]
    private var readKeys: Set<Key> = []
    private var dispatched: Set<Key> = []
    private var active = true
    private static let commands: Set<String> = ["schedule.cancel", "memory.update", "memory.delete", "reference.add", "reference.remove"]
    private static let destructive: Set<String> = ["schedule.cancel", "memory.delete", "reference.remove"]

    public init(scope: ClientDetailActionScope, transport: any ClientDetailActionTransport,
                journal: any ClientDetailActionJournal, navigation: ClientDetailActionRouting.Resolver = .init(),
                phaseChanged: @escaping PhaseChange = { _, _ in }) {
        self.scope = scope; self.transport = transport; self.journal = journal; changed = phaseChanged
        self.navigation = navigation
    }
    public func perform(documentID: String, cardID: String, action: ClientDetailAction,
                        fields: [String: ClientInspectorValue] = [:], confirm: @escaping Confirmation) async throws -> ClientDetailActionOutcome {
        guard active, scope.isValid else { throw ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED") }
        guard action.available else { throw ClientServiceFailure(statusCode: 409, code: "DETAIL_ACTION_UNAVAILABLE") }
        if action.kind == "navigation" { return .navigation(try navigation.target(for: action)) }
        guard (action.kind == "read" && ["detail.refresh", "detail.collection.page"].contains(action.operation)) ||
                (action.kind == "command" && Self.commands.contains(action.operation)) else {
            throw ClientServiceFailure(statusCode: 409, code: "DETAIL_OPERATION_UNSUPPORTED")
        }
        let key = Key(document: documentID, card: cardID, action: action.id)
        if let flight = flights[key] { return try await flight.value }
        guard flights.count < 32 else { throw ClientDetailFailure.limit }
        if action.kind == "read" {
            guard readKeys.count < 2 else { throw ClientServiceFailure(statusCode: 429, code: "DETAIL_READ_BUSY") }
            readKeys.insert(key)
        }
        let flight = Task { try await self.execute(key: key, action: action, fields: fields, confirm: confirm) }
        flights[key] = flight
        defer { flights.removeValue(forKey: key); readKeys.remove(key); dispatched.remove(key) }
        return try await flight.value
    }
    private func execute(key: Key, action: ClientDetailAction, fields: [String: ClientInspectorValue], confirm: Confirmation) async throws -> ClientDetailActionOutcome {
        do {
            var fields = fields
            if action.kind == "command" {
                if let pending = try await journal.pending(scope: scope).first(where: { $0.documentID == key.document && $0.cardID == key.card && $0.actionID == key.action }) {
                    dispatched.insert(key)
                    return .receipt(try await reconcile(pending))
                }
                guard action.expectedResourceRevision?.isEmpty == false else { throw ClientServiceFailure(statusCode: 409, code: "DETAIL_REVISION_UNSUPPORTED") }
                // Never accept a caller-supplied confirmation boolean.
                fields.removeValue(forKey: "confirmed")
                if Self.destructive.contains(action.operation) || ["required", "destructive"].contains(action.confirmation ?? "none") {
                    await changed(action.id, .confirming)
                    try Task.checkCancellation(); guard active else { throw CancellationError() }
                    let confirmed = await confirm(action)
                    try Task.checkCancellation(); guard active else { throw CancellationError() }
                    guard confirmed else {
                        await changed(action.id, .cancelled)
                        try Task.checkCancellation(); guard active else { throw CancellationError() }
                        return .cancelled
                    }
                    fields["confirmed"] = .bool(true)
                }
            }
            try Task.checkCancellation()
            guard active else { throw CancellationError() }
            let request = ClientDetailActionRequest(requestId: UUID().uuidString, documentId: key.document,
                cardId: key.card, actionId: key.action, expectedResourceRevision: action.expectedResourceRevision, fields: fields)
            try request.validate()
            if action.kind == "read" {
                await changed(action.id, .reading)
                try Task.checkCancellation(); guard active else { throw CancellationError() }
                let value: ClientInspectorValue
                do { value = try await transport.read(sessionID: scope.sessionID, request: request) }
                catch let error as URLError where [.networkConnectionLost, .timedOut, .cannotConnectToHost].contains(error.code) {
                    try await Task.sleep(for: .milliseconds(100))
                    try Task.checkCancellation(); guard active else { throw CancellationError() }
                    value = try await transport.read(sessionID: scope.sessionID, request: request)
                }
                try Task.checkCancellation(); guard active else { throw CancellationError() }
                await changed(action.id, .completed)
                try Task.checkCancellation(); guard active else { throw CancellationError() }
                return .read(value)
            }
            let pending = ClientDetailPendingAction(scope: scope, requestID: request.requestId, documentID: key.document,
                cardID: key.card, actionID: key.action, operation: action.operation, createdAt: Date())
            try await journal.save(pending) // Must succeed before dispatch.
            if Task.isCancelled || !active {
                try await journal.remove(scope: scope, requestID: pending.requestID)
                throw CancellationError()
            }
            await changed(action.id, .submitting)
            if Task.isCancelled || !active {
                try await journal.remove(scope: scope, requestID: pending.requestID)
                throw CancellationError()
            }
            let receipt: ClientCommandReceipt
            dispatched.insert(key)
            do { receipt = try await transport.command(sessionID: scope.sessionID, request: request) }
            catch {
                if let failure = error as? ClientServiceFailure,
                   ["DETAIL_FIELDS_INVALID", "CONFIRMATION_REQUIRED", "DETAIL_REVISION_CONFLICT", "DETAIL_REVISION_UNSUPPORTED", "DETAIL_TARGET_INVALID", "DETAIL_ACTION_NOT_FOUND", "DETAIL_ACTION_UNAVAILABLE", "DETAIL_DOCUMENT_CHANGED", "DETAIL_OPERATION_UNSUPPORTED", "CAPABILITY_UNSUPPORTED", "DETAIL_WRITES_UNAVAILABLE"].contains(failure.code) {
                    try await journal.remove(scope: scope, requestID: pending.requestID)
                    throw error
                }
                // Cancellation or lost transport cannot prove a write failed.
                guard active, !Task.isCancelled else { throw error }
                return .receipt(try await reconcile(pending))
            }
            try await accept(receipt, pending: pending)
            return .receipt(receipt)
        } catch {
            if active { await changed(action.id, error is ClientDetailActionUncertain || (error is CancellationError && dispatched.contains(key)) ? .unknown : error is CancellationError ? .cancelled : .failed) }
            throw error
        }
    }
    private func accept(_ receipt: ClientCommandReceipt, pending: ClientDetailPendingAction) async throws {
        guard active, !Task.isCancelled else { throw CancellationError() }
        guard receipt.schemaVersion == 1, receipt.requestId == pending.requestID, receipt.sessionId == scope.sessionID,
              receipt.kind == "inspector:detail:" + pending.operation,
              ["dispatching", "completed", "rejected", "unknown"].contains(receipt.status) else {
            throw ClientConnectionError.invalidResponse
        }
        if ["completed", "rejected"].contains(receipt.status) {
            try await journal.remove(scope: scope, requestID: pending.requestID)
        }
        guard active, !Task.isCancelled else { throw CancellationError() }
        await changed(pending.actionID, receipt.status == "completed" ? .completed : receipt.status == "rejected" ? .rejected : receipt.status == "unknown" ? .unknown : .reconciling)
        guard active, !Task.isCancelled else { throw CancellationError() }
    }
    private func reconcile(_ pending: ClientDetailPendingAction) async throws -> ClientCommandReceipt {
        guard active, !Task.isCancelled else { throw CancellationError() }
        await changed(pending.actionID, .reconciling)
        guard active, !Task.isCancelled else { throw CancellationError() }
        do {
            let receipt = try await transport.receipt(sessionID: scope.sessionID, requestID: pending.requestID)
            try await accept(receipt, pending: pending)
            return receipt
        } catch {
            guard active, !Task.isCancelled else { throw CancellationError() }
            await changed(pending.actionID, .unknown)
            throw ClientDetailActionUncertain(requestID: pending.requestID, cause: error)
        }
    }
    public func recover() async throws -> [ClientCommandReceipt] {
        guard active, scope.isValid else { throw ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED") }
        var receipts: [ClientCommandReceipt] = []
        for pending in try await journal.pending(scope: scope) { receipts.append(try await reconcile(pending)) }
        return receipts
    }
    /// Read cancellation stops work. A dispatched command retains its recovery
    /// identity; cancellation never claims that its server side effect stopped.
    @discardableResult
    public func cancel(documentID: String, cardID: String, actionID: String) -> Bool {
        let key = Key(document: documentID, card: cardID, action: actionID)
        guard !dispatched.contains(key), let flight = flights[key] else { return false }
        flight.cancel()
        return true
    }
    public func invalidate(clearRecoveryIdentity: Bool = true) async throws {
        active = false
        for task in flights.values { task.cancel() }
        flights.removeAll()
        readKeys.removeAll()
        dispatched.removeAll()
        if clearRecoveryIdentity { try await journal.clear(scope: scope) }
    }
}
