import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct QuickReplyField: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let isSending: Bool
    let placeholder: String
    let onInteract: () -> Void
    let send: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            ChatInputTextView(
                text: $text,
                placeholder: placeholder,
                font: .systemFont(ofSize: 10.5, weight: .medium),
                textInsetHeight: 2,
                onFocusChange: { focused in
                    isFocused.wrappedValue = focused
                    if focused {
                        onInteract()
                    }
                },
                onSubmit: sendIfPossible
            )
                .frame(height: 20)
                .padding(.leading, 7)
                .padding(.trailing, 3)
                .padding(.vertical, 2)

            Button {
                sendIfPossible()
            } label: {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 20, height: 20)
                } else {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 9.5, weight: .bold))
                        .frame(width: 20, height: 20)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? CorptiePalette.disabledText : CorptiePalette.softBlue)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            .help(L10n("Send reply"))
        }
        .frame(height: 26)
        .simultaneousGesture(TapGesture().onEnded(onInteract))
        .background(isFocused.wrappedValue ? CorptiePalette.inputFillFocused : CorptiePalette.inputFill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(isFocused.wrappedValue ? CorptiePalette.inputBorderFocused : CorptiePalette.inputBorder, lineWidth: isFocused.wrappedValue ? 1.25 : 1)
        )
    }

    private func sendIfPossible() {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending {
            return
        }
        send()
    }
}

/// Command feedback is intentionally observed outside `DetailView`. A send
/// transition can repaint this small label without invalidating the Timeline
/// projection or reconstructing the AppKit scroll surface.
struct SessionSendFailureView: View {
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    let sessionID: String

    var body: some View {
        if let message = commandState.sendFailures[sessionID] {
            Text(message)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("session.send-failure")
        }
    }
}

struct SessionNotReadyComposerNotice: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController

    let session: TaskSession
    let reason: SessionNotReadyReason

    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.orange)

            Text(reason.code == "PROVIDER_INITIALIZING" ? "正在启动 Provider…" : reason.presentationTitle)
                .font(.system(size: 10))
                .foregroundStyle(CorptiePalette.secondaryText)
                .lineLimit(1)
                .help(reason.presentationMessage)

            Spacer(minLength: 8)

            if reason.shouldOfferRestartRecovery,
               session.actions?.restart?.available == true {
                Button {
                    backendClient.restart(session: session)
                } label: {
                    if commandState.restartingSessionIds.contains(session.id) {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text(L10n("Restart Session"))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(commandState.restartingSessionIds.contains(session.id))
                .accessibilityLabel(L10n("Restart Session"))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.orange.opacity(0.07),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.2), lineWidth: 1)
        }
    }
}

struct ReadOnlyComposer: View {
    let reason: String?
    let isRecovering: Bool

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if isRecovering {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 11, weight: .bold))
                }
            }
            .frame(width: 28, height: 28)
            .foregroundStyle(CorptiePalette.secondaryText)

            Text(reason ?? "This session is read-only in Corptie.")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .lineLimit(2)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        )
    }
}

struct WorkspaceMissingComposer: View {
    @EnvironmentObject private var backendClient: BackendClient
    let status: WorkspaceRecoveryStatus

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder.badge.questionmark")
                .font(.system(size: 13, weight: .bold))
                .frame(width: 28, height: 28)
                .foregroundStyle(.red)

            Text(L10n("This Session is unavailable because its Workspace is missing. Rebuild the Workspace to continue."))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .lineLimit(2)

            Spacer(minLength: 0)

            if status.canRebuild == true {
                Button(L10n("Rebuild Workspace")) {
                    backendClient.recoverSelectedWorkspace(action: "rebuild")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(backendClient.isRecoveringWorkspace)
            }

            if backendClient.isRecoveringWorkspace {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.red.opacity(0.24), lineWidth: 1)
        )
    }
}

struct OfflineView: View {
    let error: String?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.orange)
            Text(L10n("Backend offline"))
                .font(.system(size: 15, weight: .semibold))
            Text(error ?? "Start the Node.js runtime to see agent tasks.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

@MainActor
func backendDisconnectedSessionMessage(wasExecuting: Bool) -> String {
    if wasExecuting {
        return L10n("Backend connection was lost while this Session was running. Its execution may have been interrupted; wait for reconnection before retrying.")
    }
    return L10n("Backend connection was lost. This Session is read-only until Corptie reconnects.")
}

struct BackendDisconnectedSessionView: View {
    let wasExecuting: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(backendDisconnectedSessionMessage(wasExecuting: wasExecuting))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.3), lineWidth: 1)
        )
    }
}

struct SessionMessageLoadFailureView: View {
    let error: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.bubble")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.orange)
            Text(L10n("Messages could not be loaded"))
                .font(.system(size: 15, weight: .semibold))
            Text(error)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Button(L10n("Reload messages"), action: retry)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ReadyEmptyView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(CorptiePalette.connected)
            Text(L10n("Backend ready"))
                .font(.system(size: 15, weight: .semibold))
            Text(L10n("Click the + button in the lower-left corner to create a session."))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
