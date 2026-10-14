import Foundation
import Observation
import CorptieClientCore

@MainActor @Observable
final class PadInspectorStore {
    struct Pending: Codable, Equatable {
        let requestID: String
        let sessionID: String
        let action: String
    }
    var snapshot: ClientInspectorSnapshot?
    var sections: [String: ClientInspectorValue] = [:]
    var error: String?
    var connected = false
    var busy = false
    var pending: Pending?
    private var scope = ""
    private var generation = UUID()
    private var authority: ClientDetailActionScope?
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    static func contextKey(_ authority: ClientDetailActionScope) throws -> String {
        guard authority.isValid else { throw ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(authority)
        return "corptie.inspector.v2:" + (try ClientDetailV2Canonical.hash(.string(String(decoding: data, as: UTF8.self))))
    }
    func retireAccess() {
        generation = UUID(); connected = false; snapshot = nil; sections = [:]; authority = nil
        error = "详情访问已失效，请重新连接后核对原操作结果"
        // Keep pending identities: retirement is not proof of command failure.
    }

    func observe(sessionID: String, connection: PadConnection) async {
        let pinned: ClientDetailActionScope, key: String
        do {
            pinned = try connection.detailActionScope(sessionID: sessionID, negotiation: .legacy)
            key = try Self.contextKey(pinned)
        } catch { retireAccess(); self.error = "详情连接身份尚未就绪"; return }
        if scope != key {
            scope = key; snapshot = nil; sections = [:]; error = nil; busy = false
            pending = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Pending.self, from: $0) }
        }
        authority = pinned
        let token = UUID(); generation = token
        var failures = 0
        defer { if token == generation { connected = false } }
        while !Task.isCancelled, generation == token {
            do {
                let api = ClientInspectorAPI(transport: try await connection.transport())
                for try await next in api.subscribe(sessionID: sessionID) {
                    guard generation == token, !Task.isCancelled else { return }
                    guard try connection.detailActionScope(sessionID: sessionID, negotiation: .legacy) == pinned else {
                        throw ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED")
                    }
                    apply(next, sessionID: sessionID)
                    connected = true; error = nil; failures = 0
                }
                connected = false
            } catch {
                guard generation == token, !Task.isCancelled else { return }
                connected = false
                if snapshot == nil || failures >= 2 {
                    self.error = PadWorktreeFailure.describe(error, stage: "读取 Detail")
                }
                if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) { retireAccess(); return }
                if case ClientConnectionError.httpStatus(let code) = error, [401, 403, 404].contains(code) { retireAccess(); return }
            }
            failures += 1
            let delaySeconds = failures == 1 ? 0.4 : min(30.0, pow(2.0, Double(min(failures, 5))))
            do { try await Task.sleep(for: .seconds(delaySeconds)) }
            catch { return }
        }
    }
    func apply(_ next: ClientInspectorSnapshot, sessionID: String) {
        guard next.sessionId == sessionID, next.schemaVersion == 1 else { return }
        snapshot = next
        for (key, code) in next.errors where code == "AUTHORIZATION_REVOKED" || code == "INVALID_CREDENTIAL"
            || code == "ACCESS_DENIED" || code == "FORBIDDEN" || code.hasSuffix("_ACCESS_DENIED")
            || code.hasSuffix("_FORBIDDEN") || code.hasSuffix("_NOT_FOUND") {
            sections.removeValue(forKey: key)
        }
        for (key, value) in next.sections where sections[key] != value { sections[key] = value }
    }
    func command(_ action: String, fields: [String: ClientInspectorValue], sessionID: String, connection: PadConnection) async {
        guard connected, !busy, pending == nil, snapshot?.sessionId == sessionID, let authority,
              (try? connection.detailActionScope(sessionID: sessionID, negotiation: .legacy)) == authority else { return }
        busy = true; error = nil
        let key = scope
        let record = Pending(requestID: UUID().uuidString, sessionID: sessionID, action: action)
        pending = record
        // Persist identity BEFORE POST. Recovery queries the same receipt; it never replays the mutation.
        do { defaults.set(try JSONEncoder().encode(record), forKey: key) }
        catch { pending = nil; busy = false; self.error = "无法保存操作凭据，未发送。"; return }
        defer { if scope == key { busy = false } }
        do {
            let api = ClientInspectorAPI(transport: try await connection.transport())
            guard scope == key, connected, (try? connection.detailActionScope(sessionID: sessionID, negotiation: .legacy)) == authority else {
                throw ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED")
            }
            let receipt = try await api.command(sessionID: sessionID, requestID: record.requestID, action: action, fields: fields)
            finish(receipt, key: key, record: record)
        } catch {
            guard scope == key else { return }
            self.error = PadWorktreeFailure.describe(error, stage: "Detail 操作", mutation: true)
            // Pre-journal validation errors are definite refusals; transport failures remain pending.
            if let failure = error as? ClientServiceFailure,
               ["INVALID_INSPECTOR_COMMAND", "SESSION_NOT_FOUND", "INVALID_CREDENTIAL"].contains(failure.code) {
                pending = nil; defaults.removeObject(forKey: key)
            }
        }
    }
    func reconcile(connection: PadConnection) async {
        guard let record = pending, !busy, let authority,
              (try? connection.detailActionScope(sessionID: authority.sessionID, negotiation: .legacy)) == authority else { return }
        let key = scope; busy = true
        defer { if scope == key { busy = false } }
        do {
            let receipt = try await ClientSessionAPI(transport: connection.transport()).receipt(requestId: record.requestID)
            finish(receipt, key: key, record: record)
        } catch { if scope == key { self.error = PadWorktreeFailure.describe(error, stage: "核对操作回执（未重发）") } }
    }
    /// Explicit local acknowledgement only; it never resends or alters the host receipt.
    func acknowledgeUnknownOutcome() {
        guard !busy, let pending else { return }
        defaults.set(try? JSONEncoder().encode(pending), forKey: scope + ":lastManuallyAcknowledged")
        defaults.removeObject(forKey: scope)
        self.pending = nil
        error = "已解除本地操作锁；原操作未重发，服务端结果仍以实际状态为准。"
    }
    private func finish(_ receipt: ClientCommandReceipt, key: String, record: Pending) {
        guard receipt.requestId == record.requestID, receipt.kind == "inspector:\(record.action)" else { return }
        if ["completed", "rejected"].contains(receipt.status) {
            defaults.removeObject(forKey: key)
            if scope == key {
                pending = nil
                error = receipt.status == "rejected" ? "操作被拒绝：\(receipt.errorCode ?? "UNKNOWN")" : nil
            }
        } else if scope == key { error = "执行结果尚未确认，请核对原操作；不要重复提交。" }
    }
}
