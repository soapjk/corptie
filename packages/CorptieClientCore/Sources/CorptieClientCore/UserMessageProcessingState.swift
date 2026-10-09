import Foundation

/// Shared authoritative lifecycle mapping for desktop and mobile messages.
public enum UserMessageProcessingState: String, Equatable, Sendable {
    case queued, processing, consumed, failed, cancelled

    public init?(authoritativeValue: String?, legacyStatus: String?) {
        if let authoritativeValue {
            guard let state = Self(rawValue: authoritativeValue.lowercased()) else { return nil }
            self = state
            return
        }
        // Receipt acceptance and timeline position never imply processing.
        switch legacyStatus?.lowercased() {
        case "queued": self = .queued
        case "running", "processing": self = .processing
        default: return nil
        }
    }
}

/// Presentation of an outgoing user's message, not of the Session's overall
/// execution. A transport receipt never proves that the Provider started.
public struct UserMessageStatusPresentation: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case sending, deliveryUnknown, accepted, queued, processing
        case deliveryFailed, processingFailed, cancelled
        case waitingToSend, retrying, deliveryBlocked, retryStopped
        case uploading, submitting
    }

    public let kind: Kind
    public let queuePosition: Int?
    public let failureReason: String?
    private let transferProgress: String?

    public init?(authoritativeStatus: String?, legacyStatus: String?,
                 localDeliveryState: String? = nil, queuePosition: Int? = nil,
                 processingError: String? = nil) {
        transferProgress = localDeliveryState?.hasPrefix("上传图片 ") == true
            ? String(localDeliveryState!.dropFirst("上传图片 ".count)) : nil
        if let state = UserMessageProcessingState(
            authoritativeValue: authoritativeStatus, legacyStatus: legacyStatus
        ) {
            switch state {
            case .queued: kind = .queued
            case .processing: kind = .processing
            case .failed: kind = .processingFailed
            case .cancelled: kind = .cancelled
            case .consumed: return nil
            }
            self.queuePosition = kind == .queued && (queuePosition ?? 0) > 0 ? queuePosition : nil
            failureReason = kind == .processingFailed ? Self.nonempty(processingError) : nil
            return
        }
        // An unknown authoritative value must not fall back to a stale local
        // "Sent" receipt or an older legacy status.
        if authoritativeStatus != nil {
            kind = .deliveryUnknown
            self.queuePosition = nil
            failureReason = nil
            return
        }
        guard let localDeliveryState = Self.nonempty(localDeliveryState) else { return nil }
        if localDeliveryState.hasPrefix("发送失败：") {
            kind = .deliveryFailed
            failureReason = Self.nonempty(String(localDeliveryState.dropFirst("发送失败：".count)))
        } else if localDeliveryState.hasPrefix("上传图片 ") {
            kind = .uploading
            failureReason = nil
        } else {
            switch localDeliveryState {
            case "Sending", "发送中": kind = .sending
            case "图片已上传，正在提交": kind = .submitting
            case "Sent", "后端已接收": kind = .accepted
            case "已保存，等待发送", "等待网络，恢复后自动发送", "等待前一条消息处理": kind = .waitingToSend
            case "等待重试，将自动发送": kind = .retrying
            case "等待恢复连接授权", "后端不支持可靠发送，请更新后端": kind = .deliveryBlocked
            case "请更新 Mac 后端以启用图片上传": kind = .deliveryBlocked
            case "发送身份未对齐，请更新 Mac 并重新连接", "旧请求需核对；不会自动重发": kind = .deliveryBlocked
            case "已停止重试；不代表撤回": kind = .retryStopped
            case "送达状态未确认": kind = .deliveryUnknown
            default: kind = .deliveryUnknown
            }
            failureReason = nil
        }
        self.queuePosition = nil
    }

    public var symbolName: String {
        switch kind {
        case .sending, .submitting: "paperplane"
        case .uploading: "arrow.up.circle"
        case .deliveryUnknown: "questionmark.circle"
        case .accepted: "checkmark.circle"
        case .queued: "clock"
        case .processing: "circle.dotted.circle"
        case .deliveryFailed, .processingFailed: "exclamationmark.circle.fill"
        case .cancelled: "xmark.circle"
        case .waitingToSend, .retrying: "clock.arrow.circlepath"
        case .deliveryBlocked: "exclamationmark.lock"
        case .retryStopped: "pause.circle"
        }
    }

    public enum Tone: Sendable { case neutral, amber, green, red }
    public enum Light: Sendable, Equatable { case blue, purple, orange, green, red, off }
    public var light: Light {
        switch kind {
        case .sending, .uploading, .submitting, .waitingToSend, .retrying: .blue
        case .deliveryUnknown, .accepted, .deliveryBlocked: .purple
        case .queued: .orange
        case .processing: .green
        case .deliveryFailed, .processingFailed: .red
        case .cancelled, .retryStopped: .off
        }
    }
    public var lightPulses: Bool { light == .blue || light == .green }
    public var tone: Tone {
        switch kind {
        case .queued: .amber
        case .waitingToSend, .retrying, .deliveryBlocked: .amber
        case .processing: .green
        case .deliveryFailed, .processingFailed: .red
        default: .neutral
        }
    }

    public func shortLabel(languageCode: String) -> String {
        let chinese = languageCode.lowercased().hasPrefix("zh")
        switch kind {
        case .sending: return chinese ? "发送中" : "Sending"
        case .uploading: return chinese ? "上传中 \(transferProgress ?? "")" : "Uploading \(transferProgress ?? "")"
        case .submitting: return chinese ? "提交中" : "Submitting"
        case .deliveryUnknown: return chinese ? "待确认" : "Unconfirmed"
        case .accepted: return chinese ? "已接收" : "Received"
        case .queued: return chinese ? "排队中" : "Queued"
        case .processing: return chinese ? "处理中" : "Processing"
        case .deliveryFailed: return chinese ? "发送失败" : "Send failed"
        case .processingFailed: return chinese ? "处理失败" : "Processing failed"
        case .cancelled: return chinese ? "已取消" : "Cancelled"
        case .waitingToSend: return chinese ? "待发送" : "Waiting to send"
        case .retrying: return chinese ? "自动重试" : "Retrying"
        case .deliveryBlocked: return chinese ? "发送暂停" : "Delivery paused"
        case .retryStopped: return chinese ? "已停重试" : "Retries stopped"
        }
    }

    public func detail(languageCode: String) -> String {
        let label = shortLabel(languageCode: languageCode)
        let chinese = languageCode.lowercased().hasPrefix("zh")
        if let failureReason { return "\(label)：\(failureReason)" }
        if kind == .queued, let queuePosition {
            return chinese ? "\(label)，当前第 \(queuePosition) 位" : "\(label), position \(queuePosition)"
        }
        if kind == .deliveryUnknown {
            return chinese ? "送达状态尚未确认；为避免重复消息，不会自动重发。"
                : "Delivery is unconfirmed. The message will not be resent automatically."
        }
        if kind == .accepted {
            return chinese ? "服务端已接收；这不代表模型已开始处理。"
                : "Received by the server; the model may not have started yet."
        }
        if kind == .waitingToSend || kind == .retrying {
            return chinese ? "消息已保存在本机，连接恢复后自动发送。"
                : "Saved on this device; delivery resumes automatically when connectivity returns."
        }
        if kind == .deliveryBlocked {
            return chinese ? "原消息已保留，请恢复连接授权或更新后端后继续发送。"
                : "Message retained; restore authorization or update the backend to resume."
        }
        if kind == .retryStopped {
            return chinese ? "已停止后续重试；不代表已撤回，后端仍可能执行已经收到的请求。"
                : "Further retries stopped. This does not withdraw a request already received by the server."
        }
        return label
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
