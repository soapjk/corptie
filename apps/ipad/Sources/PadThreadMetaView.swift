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
    @State private var showingNotReadyReason = false

    private var isReady: Bool {
        // Older hosts do not project readiness; treat their sessions as ready like the desktop did.
        capabilities?.readiness != "not_ready"
    }
    private var executionState: SessionExecutionState? {
        SessionExecutionState(executionStatus: session?.executionStatus)
    }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                Button {
                    if !isReady { showingNotReadyReason = true }
                } label: {
                    SessionReadinessLight(isReady: isReady)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(isReady)
                .accessibilityLabel(isReady ? "Session Ready" : "Session Not Ready")
                .accessibilityIdentifier("conversation-readiness")
                .popover(isPresented: $showingNotReadyReason, arrowEdge: .top) {
                    let reason = capabilities?.notReadyReason
                    SessionNotReadyDetail(
                        title: SessionReadinessPresentation.title(code: reason?.code),
                        message: SessionReadinessPresentation.message(code: reason?.code, fallback: reason?.message),
                        code: reason?.code)
                        .presentationCompactAdaptation(.popover)
                }
                if let executionState {
                    SessionExecutionStatusText(state: executionState)
                    if let activity = session?.activityStatus, !activity.isEmpty {
                        ActivityStatusText(text: activity, isActive: executionState == .running, fontSize: 9)
                            .layoutPriority(-1)
                    }
                }
            }
            .accessibilityIdentifier("conversation-execution-state")

            Spacer(minLength: 8)

            if let usage {
                PadUsageBar(usage: usage)
            }
        }
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ComposerPalette.secondaryText)
        .frame(maxWidth: .infinity)
    }
}

/// Desktop `ChatUsageBar`: context tokens and remaining plan quota as 10pt rings.
private struct PadUsageBar: View {
    let usage: ClientSessionUsage

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
        HStack(alignment: .center, spacing: 10) {
            if let context = usage.context, let remaining = context.remainingTokens, let window = context.contextWindow, window > 0 {
                let used = SessionUsagePolicy.contextUsed(usedTokens: context.usedTokens.map(Double.init),
                                                          contextWindow: Double(window), remainingTokens: Double(remaining))
                let usedPercent = SessionUsagePolicy.contextUsedPercent(reported: context.usedPercent, used: used, contextWindow: Double(window))
                SessionUsageItem(
                    icon: "text.alignleft",
                    value: "\(SessionUsagePolicy.exactTokens(used))/\(SessionUsagePolicy.exactTokens(Double(window)))",
                    progress: usedPercent / 100,
                    color: SessionMetaPalette.color(for: SessionUsagePolicy.contextTone(usedPercent: usedPercent)),
                    numericValue: used)
                    .accessibilityLabel("Context: \(SessionUsagePolicy.exactTokens(used)) / \(SessionUsagePolicy.exactTokens(Double(window))) · \(SessionUsagePolicy.percent(usedPercent, maximumFractionDigits: 2))% used")
                    .accessibilityIdentifier("conversation-usage-context")
            }
            if let quota {
                SessionUsageItem(
                    icon: "bolt.fill",
                    value: "\(SessionUsagePolicy.percent(quota.remaining))%",
                    progress: quota.remaining / 100,
                    color: SessionMetaPalette.color(for: SessionUsagePolicy.quotaTone(remainingPercent: quota.remaining)))
                    .accessibilityLabel("\(SessionUsagePolicy.quotaLabel(provider: usage.account?.provider)): \(SessionUsagePolicy.percent(quota.remaining, maximumFractionDigits: 2))% remaining")
                    .accessibilityIdentifier("conversation-usage-quota")
            }
        }
        .font(.system(size: 9, weight: .semibold))
        .fixedSize(horizontal: true, vertical: false)
    }

    private static func snapshot(_ limit: ClientSessionUsage.RateLimit) -> SessionUsagePolicy.Snapshot {
        .init(limitName: limit.limitName, primary: limit.primary.map(window), secondary: limit.secondary.map(window))
    }

    private static func window(_ value: ClientSessionUsage.Window) -> SessionUsagePolicy.Window {
        .init(usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt)
    }
}
