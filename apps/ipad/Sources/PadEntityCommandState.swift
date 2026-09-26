import Foundation
import CryptoKit
import Observation
import CorptieClientCore

/// One Work / Task management command at a time (the macOS outline context menus).
/// The request id is persisted before the POST so a lost response is reconciled by
/// reading the receipt; the POST itself is never replayed (§10.2).
@MainActor @Observable
final class PadEntityCommandState {
    enum Target: Codable, Equatable {
        case task(String)
        case work(String)
    }
    struct Pending: Codable, Equatable {
        let requestID: String
        let kind: String
        let target: Target
        /// Human label for notices, e.g. "归档 Task".
        let label: String
    }
    struct Outcome: Equatable {
        let pending: Pending
        let status: String
        let errorCode: String?
        let result: ClientEntityCommandResult?
    }
    /// Codes the host guarantees are raised before any receipt is journaled.
    static let preDispatchCodes: Set<String> = ["INVALID_CREDENTIAL", "INVALID_TASK_COMMAND",
        "INVALID_WORK_COMMAND", "INVALID_TASK_ID", "INVALID_WORK_ID", "TASK_NOT_FOUND", "WORK_NOT_FOUND", "AGENT_OUTSIDE_WORK",
        "AGENT_NOT_FOUND", "IDEMPOTENCY_CONFLICT", "CAPABILITY_UNSUPPORTED", "ROUTE_NOT_AVAILABLE", "COMMAND_JOURNAL_FULL"]

    private let serverID: String
    private let address: String
    private let deviceID: String?
    private let defaults: UserDefaults
    private let storageKey: String
    private(set) var pending: Pending?
    private(set) var submitting = false
    private(set) var checking = false
    private(set) var recoveryBlocked = false
    private(set) var reconciliationDenied = false
    /// Last final outcome; the view refreshes inventory when it changes.
    private(set) var outcome: Outcome?
    var notice = ""

    init(connection: PadConnection, defaults: UserDefaults = .standard) {
        serverID = connection.serverID; address = connection.address; deviceID = connection.deviceID
        self.defaults = defaults
        let keyData = try! JSONEncoder().encode([serverID, address, deviceID ?? ""])
        storageKey = "entityCommand:" + SHA256.hash(data: keyData).map { String(format: "%02x", $0) }.joined()
        if let data = defaults.data(forKey: storageKey) {
            if let record = try? JSONDecoder().decode(Pending.self, from: data) {
                pending = record
            } else {
                recoveryBlocked = true
                notice = "无法读取本地操作记录。为避免重复执行，已停止 Work / Task 管理操作。"
            }
        }
    }

    func matches(_ connection: PadConnection) -> Bool {
        connection.serverID == serverID && connection.address == address && connection.deviceID == deviceID
    }

    var isBusy: Bool { submitting || pending != nil || recoveryBlocked }

    func isPending(_ target: Target) -> Bool { pending?.target == target }

    /// Runs one command. Returns the receipt when the host answered; `nil` when the
    /// request was refused before dispatch or the outcome is still unknown.
    @discardableResult
    func run(_ connection: PadConnection, target: Target, kind: String, label: String,
             send: (ClientSessionAPI, String) async throws -> ClientCommandReceipt) async -> ClientCommandReceipt? {
        guard matches(connection), !isBusy else { return nil }
        submitting = true; notice = ""
        defer { submitting = false }
        let requestID = UUID().uuidString
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            guard matches(connection), !Task.isCancelled, pending == nil else { return nil }
            pending = Pending(requestID: requestID, kind: kind, target: target, label: label)
            flush()
            let receipt = try await send(api, requestID)
            guard matches(connection) else { return nil }
            accept(receipt)
            return receipt
        } catch {
            guard matches(connection) else { return nil }
            if let failure = error as? ClientServiceFailure, Self.preDispatchCodes.contains(failure.code) {
                pending = nil; flush(); notice = Self.explain(failure, label: label)
            } else if let failure = error as? ClientConnectionError,
                      failure == .httpStatus(401) || failure == .httpStatus(403) || failure == .httpStatus(404) {
                pending = nil; flush(); notice = PadConnection.explain(failure)
            } else {
                notice = pending == nil ? PadConnection.explain(error) : "\(label)的结果尚未确认；已保留请求，不会重复执行。"
            }
            return nil
        }
    }

    /// Queries the receipt only; never re-sends.
    func reconcile(_ connection: PadConnection) async {
        guard matches(connection), let pending, !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            guard matches(connection), !Task.isCancelled else { return }
            let receipt = try await api.receipt(requestId: pending.requestID)
            guard matches(connection), !Task.isCancelled else { return }
            reconciliationDenied = false
            accept(receipt)
        } catch {
            guard matches(connection), !Task.isCancelled else { return }
            if let failure = error as? ClientServiceFailure, failure.code == "INVALID_CREDENTIAL" {
                reconciliationDenied = true
            }
            if let failure = error as? ClientConnectionError, failure == .httpStatus(401) || failure == .httpStatus(403) {
                reconciliationDenied = true
            }
            notice = "暂时无法核对\(pending.label)的结果；请求已保留，请勿重复操作。"
        }
    }

    func acceptPushed(_ receipt: ClientCommandReceipt) {
        guard pending?.requestID == receipt.requestId else { return }
        accept(receipt)
    }

    private func accept(_ receipt: ClientCommandReceipt) {
        guard let pending, receipt.requestId == pending.requestID, receipt.kind == pending.kind else {
            notice = "操作回执不匹配，已保留原请求。"; return
        }
        switch receipt.status {
        case "completed":
            outcome = Outcome(pending: pending, status: "completed", errorCode: nil, result: receipt.entityResult)
            self.pending = nil
            flush()
            notice = pending.kind == "task_delete"
                ? "Task 删除请求已提交，后台清理状态会随列表更新。"
                : "\(pending.label)已完成。"
        case "rejected":
            outcome = Outcome(pending: pending, status: "rejected", errorCode: receipt.errorCode, result: nil)
            self.pending = nil; flush()
            notice = Self.explain(ClientServiceFailure(statusCode: 409, code: receipt.errorCode ?? "REJECTED"), label: pending.label)
        case "unknown":
            // Durable on the host as uncertain; it will not change, so stop polling and tell the user to check.
            outcome = Outcome(pending: pending, status: "unknown", errorCode: receipt.errorCode, result: nil)
            self.pending = nil; flush()
            notice = "\(pending.label)的结果不确定，请刷新列表核对；未重复执行。"
        default:
            notice = "正在执行\(pending.label)…"
        }
    }

    static func explain(_ failure: ClientServiceFailure, label: String) -> String {
        switch failure.code {
        case "TASK_DELETING": return "该 Task 正在删除，无法\(label)。"
        case "WORK_TASK_DELETING": return "Work 内有 Task 正在删除，请稍后再试。"
        case "TASK_ARCHIVED": return "Task 已归档。"
        case "TASK_NOT_ARCHIVED": return "Task 未归档。"
        case "TASK_COMPLETED": return "已完成的 Task 不需要归档。"
        case "TASK_ARCHIVE_BUSY": return "请先停止 Task 执行，再归档。"
        case "TASK_ARCHIVE_PENDING_WAKE": return "请先取消等待执行的计划任务，再归档。"
        case "TASK_SESSION_NOT_FOUND", "SESSION_NOT_AVAILABLE": return "该 Task 没有可重启的会话。"
        case "TASK_DELETE_BLOCKED": return "当前无法安全删除该 Task，请先处理阻止项。"
        case "TASK_DELETE_RISK_CONFIRMATION_REQUIRED", "TASK_FORCE_DELETE_CONFIRMATION_REQUIRED":
            return "删除需要重新确认风险，请再次打开删除确认。"
        case "TASK_DELETE_FORBIDDEN": return "Mac 端拒绝了此设备的删除请求。"
        case "IDEMPOTENCY_CONFLICT": return "请求与已有记录冲突，未执行；请刷新后重试。"
        case "INVALID_TASK_COMMAND", "INVALID_WORK_COMMAND": return "输入不符合要求，未执行。"
        default: return PadConnection.explain(failure)
        }
    }

    func flush() {
        guard !recoveryBlocked else { return }
        if let pending, let data = try? JSONEncoder().encode(pending) {
            defaults.set(data, forKey: storageKey)
        } else {
            defaults.removeObject(forKey: storageKey)
        }
    }
}
