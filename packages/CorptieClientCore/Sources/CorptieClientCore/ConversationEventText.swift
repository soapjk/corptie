import Foundation

/// Product event vocabulary only. Never translate user titles or message bodies.
public struct ConversationEventText: Sendable {
    public let languageCode: String
    public init(languageCode: String) { self.languageCode = languageCode }
    public func text(_ chinese: String, _ english: String) -> String {
        languageCode.lowercased().hasPrefix("zh") ? chinese : english
    }
    public var automationTitle: String { text("计划任务事件", "Scheduled task event") }
    public func messageSource(name: String?) -> String {
        let prefix = text("计划任务触发", "Scheduled task message")
        guard let name, !name.isEmpty else { return prefix }
        return prefix + " · " + name
    }
    public func runStatus(_ status: String?) -> String {
        switch status {
        case "queued": text("已排队", "Queued")
        case "running": text("处理中", "Processing")
        case "completed": text("完成", "Completed")
        case "failed": text("失败", "Failed")
        case "cancelled": text("取消", "Cancelled")
        case "missed", "skipped": text("已跳过", "Skipped")
        case "pending", "dispatching", "scheduled", "claimed": text("已触发", "Triggered")
        case "retry_wait": text("等待重试", "Waiting to retry")
        default: text("状态待确认", "Status unconfirmed")
        }
    }
    public var systemTitle: String { text("系统事件", "System event") }
    public var reasonLabel: String { text("原因", "Reason") }
    public var systemNotice: String { text("此事件不可作为协作请求执行。", "This event is not an executable collaboration request.") }
    public func executionPlan(trigger: String?, runAt: String?, nextRunAt: String?, interval: Double?,
                              conditionInterval: Double?, processInterval: Double?,
                              formatDate: (String?) -> String?) -> String? {
        func duration(_ seconds: Double?) -> String? {
            guard let seconds, seconds.isFinite, seconds >= 1, seconds < Double(Int.max) else { return nil }
            let value = Int(seconds.rounded(.down))
            if value.isMultiple(of: 3600) { return text("\(value / 3600) 小时", "\(value / 3600) h") }
            if value.isMultiple(of: 60) { return text("\(value / 60) 分钟", "\(value / 60) min") }
            return text("\(value) 秒", "\(value) s")
        }
        switch trigger {
        case "at", "once", "after":
            guard let date = formatDate(runAt ?? nextRunAt) else { return nil }
            return trigger == "after" ? text("延时至 \(date) 执行", "Run after waiting until \(date)") : text("于 \(date) 执行", "Run at \(date)")
        case "interval":
            guard let value = duration(interval) else { return nil }
            let base = text("每 \(value)执行", "Run every \(value)")
            guard let date = formatDate(nextRunAt ?? runAt) else { return base }
            return base + text("；下次执行：\(date)", "; next run: \(date)")
        case "condition", "process", "processExit":
            let condition = trigger == "condition"
            let base = condition ? text("条件满足时执行", "Run when the condition is met") : text("监控的进程退出时执行", "Run when the monitored process exits")
            guard let value = duration(condition ? conditionInterval : processInterval) else { return base }
            return base + text("；每 \(value) 检查一次", "; check every \(value)")
        default: return nil
        }
    }
    public func eventLabel(_ type: String?) -> String {
        switch type {
        case "ScheduledSessionTaskCreated": text("已创建", "Created")
        case "ScheduledSessionTaskDue": text("已触发", "Triggered")
        case "ScheduledSessionRunQueued": text("已排队", "Queued")
        default: automationTitle
        }
    }
    public func timeLabel(_ type: String?) -> String {
        switch type {
        case "ScheduledSessionTaskCreated": text("创建时间", "Created at")
        case "ScheduledSessionTaskDue": text("触发时间", "Triggered at")
        case "ScheduledSessionRunQueued": text("排队时间", "Queued at")
        default: text("事件时间", "Event time")
        }
    }
    public func systemKind(_ kind: String?) -> String {
        switch kind {
        case "invalid_collaboration_envelope": text("协作消息无法验证", "Unverified collaboration message")
        case "invalid_session_channel_envelope": text("会话通道消息无法验证", "Unverified session channel message")
        default: systemTitle
        }
    }
    public func reason(_ code: String?) -> String {
        switch code {
        case "not_collaboration": text("该事件不是协作请求。", "This event is not a collaboration request.")
        case "missing_task_id": text("缺少关联任务信息。", "Associated task information is missing.")
        case "task_not_found": text("找不到关联任务。", "The associated task was not found.")
        case "envelope_not_found", "CHANNEL_DELIVERY_ENVELOPE_MISSING": text("缺少可验证的消息信息。", "Verifiable message information is missing.")
        case "missing_sender_session_id": text("缺少发送会话信息。", "Sender session information is missing.")
        case "missing_recipient_session_id": text("缺少接收会话信息。", "Recipient session information is missing.")
        case "missing_source_work_id": text("缺少来源 Work 信息。", "Source Work information is missing.")
        case "missing_target_work_id": text("缺少目标 Work 信息。", "Target Work information is missing.")
        case "missing_message_body": text("缺少消息正文。", "The message body is missing.")
        default: text("暂无法识别此事件的具体原因。", "The specific reason for this event is unavailable.")
        }
    }
    public func source(_ code: String?) -> String {
        switch code {
        case "session_channel": text("会话通道", "Session channel")
        case "collaboration": text("协作", "Collaboration")
        case "user": text("用户", "User")
        case "system": text("系统", "System")
        case "feishu": text("飞书", "Feishu")
        default: text("未知", "Unknown")
        }
    }
}
