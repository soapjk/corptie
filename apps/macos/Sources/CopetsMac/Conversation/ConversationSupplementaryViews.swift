import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct OrphanedWorkspaceRecoveryView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    let status: WorkspaceRecoveryStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "folder.badge.questionmark")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("Workspace missing"))
                        .font(.system(size: 13, weight: .bold))
                    Text(L10n("This session is preserved, but Session work is blocked until the workspace is restored or switched."))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    if let path = status.originalPath {
                        Text(path)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(CorptiePalette.mutedText)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
                if backendClient.isRecoveringWorkspace {
                    ProgressView().controlSize(.small)
                }
            }

            HStack(spacing: 8) {
                if status.canRebuild == true {
                    Button(L10n("Rebuild Workspace")) {
                        backendClient.recoverSelectedWorkspace(action: "rebuild")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(backendClient.isRecoveringWorkspace)
                }

                Menu(L10n("Switch Workspace")) {
                    ForEach(status.worktrees) { worktree in
                        Button(worktree.isMain
                            ? L10nFormat("Main — %@", worktree.path)
                            : L10nFormat("%@ — %@", worktree.branchName ?? L10n("detached HEAD"), worktree.path)) {
                            backendClient.recoverSelectedWorkspace(
                                action: "switch",
                                targetWorktreeId: worktree.worktreeId
                            )
                        }
                    }
                }
                .controlSize(.small)
                .disabled(status.worktrees.isEmpty || backendClient.isRecoveringWorkspace)

                Spacer()

                if let session = backendClient.selectedSession {
                    Button(L10n("Delete Session Only"), role: .destructive) {
                        backendClient.delete(session: session)
                    }
                    .controlSize(.small)
                    .disabled(backendClient.isRecoveringWorkspace)
                }
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.red.opacity(0.22), lineWidth: 0.75)
        )
    }
}

struct ChatUsageBar: View {
    let sessionID: String
    let usage: SessionUsageResponse?
    var loadState: UsageLoadState = .ready
    var isDraft = false
    var inline = false
    var accountSupported: Bool? = nil
    var contextSupported: Bool? = nil
    @State private var isResetNoticePresented = false
    @State private var bankedResetState: BankedResetState = .idle

    private enum BankedResetState: Equatable {
        case idle
        case loading
        case ready(CodexRateLimitResetCredits?)
        case failed
    }

    var body: some View {
        Group {
            if inline {
                HStack(spacing: 6) {
                    if hasLoadFailure {
                        Image(systemName: "exclamationmark.circle")
                            .help(L10n("用量加载失败")).accessibilityLabel(L10n("用量加载失败"))
                    }
                    usageItems
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    if hasLoadFailure { Text(L10n("用量加载失败")).foregroundStyle(.secondary) }
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .center, spacing: 6) { usageItems }
                        VStack(alignment: .leading, spacing: 2) { usageItems }
                    }
                }
            }
        }
        .font(.system(size: 9, weight: .semibold))
        .lineLimit(inline ? 1 : 2)
        .task(id: "\(sessionID):\(isResetNoticePresented)") {
            guard !isDraft, isResetNoticePresented else {
                bankedResetState = .idle
                return
            }
            bankedResetState = .loading
            let refreshed = await BackendClient.shared.usageController.refreshFreshAccount(for: sessionID)
            guard !Task.isCancelled else { return }
            if let refreshed {
                bankedResetState = .ready(refreshed.account.rateLimitResetCredits)
            } else {
                bankedResetState = .failed
            }
        }
        .onChange(of: usage?.account.model) { _, _ in isResetNoticePresented = false }
        .onChange(of: usage?.account.provider) { _, _ in isResetNoticePresented = false }
    }

    private var hasLoadFailure: Bool {
        loadState == .failed || usage?.accountLoadFailed == true || usage?.contextLoadFailed == true
    }

    @ViewBuilder
    private var usageItems: some View {
        if !isDraft, contextSupported != false, let context = usage?.context?.displayValues {
            ConversationComposerUsageSlot {
                SessionUsageItem(
                    icon: "text.alignleft",
                    value: "\(L10n("Context used")) \(SessionUsagePolicy.percent(context.percent))%",
                    progress: context.percent / 100,
                    color: SessionMetaPalette.color(for: SessionUsagePolicy.contextTone(usedPercent: context.percent)),
                    numericValue: context.used
                )
            }
            .help("\(L10n("Context")): \(SessionUsagePolicy.exactTokens(context.used)) / \(SessionUsagePolicy.exactTokens(context.window))")
            .accessibilityLabel("\(L10n("Context")): \(SessionUsagePolicy.exactTokens(context.used)) / \(SessionUsagePolicy.exactTokens(context.window))")
            .accessibilityIdentifier("conversation-usage-context")
        } else if !isDraft {
            Text(L10n(UsagePlaceholderPolicy.key(
                context: true, supported: contextSupported, loading: usage == nil && loadState == .loading,
                failed: loadState == .failed || usage?.contextLoadFailed == true)))
                .foregroundStyle(.secondary)
        }
        if accountSupported != false, let usage,
           let window = SessionUsagePresentation.preferredRateLimitWindow(usage.account),
           let remainingPercent = SessionUsagePresentation.remainingRateLimitPercent(window) {
            Button {
                isResetNoticePresented.toggle()
            } label: {
                ConversationComposerUsageSlot {
                    SessionUsageItem(
                        icon: "bolt.fill",
                        value: "\(L10n("Quota remaining")) \(SessionUsagePolicy.percent(remainingPercent))%",
                        progress: remainingPercent / 100,
                        color: SessionMetaPalette.color(for: SessionUsagePolicy.quotaTone(remainingPercent: remainingPercent))
                    )
                }
            }
            .buttonStyle(.plain)
            .help(isDraft ? L10n("最近记录的额度") : "\(L10n(SessionUsagePolicy.quotaLabel(provider: usage.account.provider))): \(SessionUsagePolicy.percent(remainingPercent, maximumFractionDigits: 2))% remaining")
            .accessibilityLabel("\(L10n(SessionUsagePolicy.quotaLabel(provider: usage.account.provider))): \(SessionUsagePolicy.percent(remainingPercent, maximumFractionDigits: 2))% remaining")
            .accessibilityIdentifier("conversation-usage-quota")
            .popover(isPresented: $isResetNoticePresented, arrowEdge: .bottom) {
                resetNoticePopover(usage: usage, window: window)
            }
        } else {
            Text(L10n(UsagePlaceholderPolicy.key(context: false, supported: accountSupported,
                loading: usage == nil && loadState == .loading,
                failed: loadState == .failed || usage?.accountLoadFailed == true)))
                .foregroundStyle(.secondary)
        }
    }

    private func resetNoticePopover(
        usage: SessionUsageResponse,
        window: CodexRateLimitWindow
    ) -> some View {
        let bankedResets = displayedBankedResets(fallback: usage.account.rateLimitResetCredits)
        let expirationDates = bankedResets?.availableExpirationDates() ?? []
        let verification: SessionQuotaResetDetails.Verification = switch bankedResetState {
        case .loading: .loading
        case .failed: .failed
        case .idle, .ready: .idle
        }
        return SessionQuotaResetDetails(
            verification: verification,
            loadingText: L10n("Updating banked resets; showing the last known value…"),
            failureText: L10n("Banked resets could not be verified; showing the last known value."),
            resetText: L10nFormat("Plan reset: %@", formattedResetDate(window.resetsAt)),
            bankedText: bankedResets.map {
                L10nFormat("Banked resets remaining: %lld", Int64(max(0, $0.availableCount)))
            },
            expiryText: bankedResets.flatMap { resets in
                guard resets.availableCount > 0 else { return nil }
                return expirationDates.first.map {
                    L10nFormat("Earliest banked reset expiry: %@", formattedBankedResetDate($0))
                } ?? L10n("Banked reset expiry unavailable")
            },
            expiryHelp: expirationDates.map(formattedBankedResetDate).joined(separator: "\n")
        )
        .foregroundStyle(CorptiePalette.primaryText)
        .fixedSize(horizontal: true, vertical: true)
    }

    private func formattedResetDate(_ epochSeconds: Double?) -> String {
        guard let epochSeconds else { return L10n("Unknown") }
        return Date(timeIntervalSince1970: epochSeconds).formatted(
            date: .abbreviated,
            time: .shortened
        )
    }

    private func displayedBankedResets(
        fallback: CodexRateLimitResetCredits?
    ) -> CodexRateLimitResetCredits? {
        if case .ready(let refreshed) = bankedResetState {
            return refreshed
        }
        return fallback
    }

    private func formattedBankedResetDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

}

/// Text states are deliberately separate from numerical data; unknown never means zero.
enum UsagePlaceholderPolicy {
    static func key(context: Bool, supported: Bool?, loading: Bool, failed: Bool) -> String {
        if supported == false { return context ? "上下文：不支持" : "额度：不支持" }
        if failed { return context ? "上下文：加载失败" : "额度：刷新失败" }
        if loading { return context ? "上下文：加载中…" : "额度：加载中…" }
        return context ? "上下文：暂无数据" : "额度：暂无数据"
    }
}
