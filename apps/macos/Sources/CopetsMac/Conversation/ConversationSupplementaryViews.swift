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
                    Text(L10n("This session is preserved, but Agent work is blocked until the workspace is restored or switched."))
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
    @State private var isResetNoticePresented = false
    @State private var bankedResetState: BankedResetState = .idle

    private enum BankedResetState: Equatable {
        case idle
        case loading
        case ready(CodexRateLimitResetCredits)
        case failed
    }

    var body: some View {
        if let usage {
            HStack(alignment: .center, spacing: 10) {
                if let context = usage.context,
                   let remaining = context.remainingTokens,
                   let window = context.contextWindow, window > 0 {
                    let used = SessionUsagePolicy.contextUsed(usedTokens: context.usedTokens,
                        contextWindow: window, remainingTokens: remaining)
                    let usedPercent = SessionUsagePolicy.contextUsedPercent(reported: context.usedPercent,
                        used: used, contextWindow: window)
                    ConversationComposerUsageSlot {
                        SessionUsageItem(
                            icon: "text.alignleft",
                            value: "\(SessionUsagePolicy.exactTokens(used))/\(SessionUsagePolicy.exactTokens(window))",
                            progress: usedPercent / 100,
                            color: SessionMetaPalette.color(for: SessionUsagePolicy.contextTone(usedPercent: usedPercent)),
                            numericValue: used
                        )
                    }
                    .help("\(L10n("Context")): \(SessionUsagePolicy.exactTokens(used)) / \(SessionUsagePolicy.exactTokens(window)) · \(SessionUsagePolicy.percent(usedPercent, maximumFractionDigits: 2))% used")
                    .accessibilityLabel("\(L10n("Context")): \(SessionUsagePolicy.exactTokens(used)) / \(SessionUsagePolicy.exactTokens(window)) · \(SessionUsagePolicy.percent(usedPercent, maximumFractionDigits: 2))% used")
                    .accessibilityIdentifier("conversation-usage-context")
                }
                if let window = SessionUsagePresentation.preferredRateLimitWindow(usage.account),
                   let remainingPercent = SessionUsagePresentation.remainingRateLimitPercent(window) {
                    if usage.account.provider == "codex" {
                        Button {
                            isResetNoticePresented.toggle()
                        } label: {
                            ConversationComposerUsageSlot {
                                SessionUsageItem(
                                    icon: "bolt.fill",
                                    value: "\(SessionUsagePolicy.percent(remainingPercent))%",
                                    progress: remainingPercent / 100,
                                    color: SessionMetaPalette.color(for: SessionUsagePolicy.quotaTone(remainingPercent: remainingPercent))
                                )
                            }
                        }
                        .buttonStyle(.plain)
                        .help("\(L10n(SessionUsagePolicy.quotaLabel(provider: usage.account.provider))): \(SessionUsagePolicy.percent(remainingPercent, maximumFractionDigits: 2))% remaining")
                        .accessibilityLabel("\(L10n(SessionUsagePolicy.quotaLabel(provider: usage.account.provider))): \(SessionUsagePolicy.percent(remainingPercent, maximumFractionDigits: 2))% remaining")
                        .accessibilityIdentifier("conversation-usage-quota")
                        .popover(isPresented: $isResetNoticePresented, arrowEdge: .bottom) {
                            resetNoticePopover(usage: usage, window: window)
                        }
                        .task(id: "\(sessionID):\(isResetNoticePresented)") {
                            guard isResetNoticePresented else {
                                bankedResetState = .idle
                                return
                            }
                            bankedResetState = .loading
                            let refreshed = await BackendClient.shared.usageController.refreshFreshAccount(for: sessionID)
                            guard !Task.isCancelled else { return }
                            if let resets = refreshed?.account.rateLimitResetCredits {
                                bankedResetState = .ready(resets)
                            } else {
                                bankedResetState = .failed
                            }
                        }
                    } else {
                        ConversationComposerUsageSlot {
                            SessionUsageItem(
                                icon: "bolt.fill",
                                value: "\(SessionUsagePolicy.percent(remainingPercent))%",
                                progress: remainingPercent / 100,
                                color: SessionMetaPalette.color(for: SessionUsagePolicy.quotaTone(remainingPercent: remainingPercent))
                            )
                        }
                        .help("\(L10n(SessionUsagePolicy.quotaLabel(provider: usage.account.provider))): \(SessionUsagePolicy.percent(remainingPercent, maximumFractionDigits: 2))% remaining")
                        .accessibilityIdentifier("conversation-usage-quota")
                    }
                }
            }
            .font(.system(size: 9, weight: .semibold))
            .fixedSize(horizontal: true, vertical: false)
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
