import SwiftUI
import CorptieClientCore
import CorptieConversation

/// The desktop `ThreadMetaView` on iPad: readiness light (tap for the reason),
/// execution state, activity text, then context / quota usage at the trailing
/// edge. All values come from the capabilities projection and the usage read.
struct PadThreadMetaView: View {
    let session: ClientSession?
    let capabilities: ClientSessionCapabilities?
    let usage: ClientSessionUsage?
    let refreshAccount: () async -> ClientSessionUsage?
    var compactUsage = false

    private var isReady: Bool {
        // Older hosts do not project readiness; treat their sessions as ready like the desktop did.
        capabilities?.readiness != "not_ready"
    }

    var body: some View {
        let reason = capabilities?.notReadyReason
        ConversationComposerStatusRow(
            isReady: isReady,
            readinessTitle: SessionReadinessPresentation.title(code: reason?.code),
            readinessMessage: SessionReadinessPresentation.message(code: reason?.code, fallback: reason?.message),
            readinessCode: reason?.code,
            executionState: SessionExecutionState(executionStatus: session?.executionStatus),
            activity: session?.activityStatus
        ) {
            if let usage {
                PadUsageBar(usage: usage, compact: compactUsage, refreshAccount: refreshAccount)
            }
        }
    }
}

/// Desktop `ChatUsageBar`: context tokens and remaining plan quota as 10pt rings.
private struct PadUsageBar: View {
    let usage: ClientSessionUsage
    let compact: Bool
    let refreshAccount: () async -> ClientSessionUsage?
    @State private var isResetNoticePresented = false
    @State private var verification: SessionQuotaResetDetails.Verification = .idle
    @State private var refreshedCredits: ClientSessionUsage.RateLimitResetCredits?

    private var quota: (window: SessionUsagePolicy.Window, remaining: Double)? {
        guard let account = usage.account else { return nil }
        let shared = SessionUsagePolicy.Account(
            provider: account.provider, model: account.model,
            rateLimits: account.rateLimits.map(Self.snapshot),
            rateLimitsByLimitId: account.rateLimitsByLimitId?.mapValues(Self.snapshot))
        guard let window = SessionUsagePolicy.preferredRateLimitWindow(shared),
              let remaining = SessionUsagePolicy.remainingRateLimitPercent(window) else { return nil }
        return (window, remaining)
    }

    var body: some View {
        HStack(alignment: .center, spacing: compact ? 4 : 10) {
            if let context = usage.context, let remaining = context.remainingTokens, let window = context.contextWindow, window > 0 {
                let used = SessionUsagePolicy.contextUsed(usedTokens: context.usedTokens.map(Double.init),
                                                          contextWindow: Double(window), remainingTokens: Double(remaining))
                let usedPercent = SessionUsagePolicy.contextUsedPercent(reported: context.usedPercent, used: used, contextWindow: Double(window))
                ConversationComposerUsageSlot {
                    SessionUsageItem(
                        icon: "text.alignleft",
                        value: "\(SessionUsagePolicy.exactTokens(used))/\(SessionUsagePolicy.exactTokens(Double(window)))",
                        progress: usedPercent / 100,
                        color: SessionMetaPalette.color(for: SessionUsagePolicy.contextTone(usedPercent: usedPercent)),
                        numericValue: used)
                }
                .accessibilityLabel("Context: \(SessionUsagePolicy.exactTokens(used)) / \(SessionUsagePolicy.exactTokens(Double(window))) · \(SessionUsagePolicy.percent(usedPercent, maximumFractionDigits: 2))% used")
                .accessibilityIdentifier("conversation-usage-context")
            }
            if let quota {
                // Quota details are supported by the usage data, not a Provider identifier.
                Button { isResetNoticePresented.toggle() } label: {
                    quotaSlot(remaining: quota.remaining)
                }
                .buttonStyle(.plain)
                .popover(isPresented: $isResetNoticePresented, arrowEdge: .bottom) {
                    resetNoticePopover(window: quota.window)
                        .presentationCompactAdaptation(.popover)
                }
                .task(id: isResetNoticePresented) {
                    guard isResetNoticePresented else {
                        verification = .idle
                        refreshedCredits = nil
                        return
                    }
                    verification = .loading
                    let refreshed = await refreshAccount()
                    guard !Task.isCancelled else { return }
                    if let refreshed, let account = refreshed.account {
                        refreshedCredits = account.rateLimitResetCredits
                        verification = .idle
                    } else {
                        verification = .failed
                    }
                }
                .accessibilityLabel(quotaAccessibilityLabel(remaining: quota.remaining))
                .accessibilityIdentifier("conversation-usage-quota")
            }
        }
        .font(.system(size: 9, weight: .semibold))
        .fixedSize(horizontal: true, vertical: false)
    }

    private func quotaSlot(remaining: Double) -> some View {
        ConversationComposerUsageSlot {
            SessionUsageItem(
                icon: "bolt.fill",
                value: "\(SessionUsagePolicy.percent(remaining))%",
                progress: remaining / 100,
                color: SessionMetaPalette.color(for: SessionUsagePolicy.quotaTone(remainingPercent: remaining)))
        }
    }

    private func quotaAccessibilityLabel(remaining: Double) -> String {
        "\(SessionUsagePolicy.quotaLabel(provider: usage.account?.provider)): \(SessionUsagePolicy.percent(remaining, maximumFractionDigits: 2))% remaining"
    }

    private func resetNoticePopover(window: SessionUsagePolicy.Window) -> some View {
        let credits = refreshedCredits ?? usage.account?.rateLimitResetCredits
        let expirationDates = (credits?.credits ?? [])
            .filter { $0.status == "available" }
            .compactMap(\.expiresAt)
            .filter { $0.isFinite && $0 > Date.now.timeIntervalSince1970 }
            .map(Date.init(timeIntervalSince1970:))
            .sorted()
        let formattedDate: (Date) -> String = { $0.formatted(date: .abbreviated, time: .shortened) }
        let resetDate = window.resetsAt.map { formattedDate(Date(timeIntervalSince1970: $0)) } ?? "未知"
        return SessionQuotaResetDetails(
            verification: verification,
            loadingText: "正在刷新已存额度重置；以下为上次记录…",
            failureText: "无法核实当前已存额度重置；以下为上次记录。",
            resetText: "套餐重置：\(resetDate)",
            bankedText: credits?.availableCount.map { "已存额度重置：剩余 \(max(0, $0)) 次" },
            expiryText: (credits?.availableCount ?? 0) > 0
                ? expirationDates.first.map { "最早过期：\(formattedDate($0))" } ?? "已存额度重置的过期时间暂不可用"
                : nil,
            expiryHelp: expirationDates.map(formattedDate).joined(separator: "\n")
        )
        .accessibilityIdentifier("conversation-usage-quota-details")
    }

    private static func snapshot(_ limit: ClientSessionUsage.RateLimit) -> SessionUsagePolicy.Snapshot {
        .init(limitName: limit.limitName, primary: limit.primary.map(window), secondary: limit.secondary.map(window))
    }

    private static func window(_ value: ClientSessionUsage.Window) -> SessionUsagePolicy.Window {
        .init(usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt)
    }
}
