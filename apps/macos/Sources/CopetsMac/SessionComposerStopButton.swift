import SwiftUI
import CorptieConversation

/// Targets the displayed Session, including workspace cards and detached chats.
/// Hidden controls occupy no space in the composer toolbar.
struct SessionComposerStopButton: View {
    @EnvironmentObject private var backendClient: BackendClient
    let session: TaskSession?
    var compact = false

    var body: some View {
        SessionComposerStopSurface(session: session, online: backendClient.isOnline, compact: compact) {
            guard let session else { return }
            backendClient.interrupt(session: session, surface: .sessionDetailComposerControl)
        }
    }
}

struct SessionComposerStopSurface: View {
    let session: TaskSession?
    let online: Bool
    var compact = false
    let interrupt: () -> Void
    var body: some View {
        ZStack {
            if let session,
               session.executionTaskStatus == .running,
               session.canInterruptNow {
                Button(action: interrupt) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.red)
                        .frame(width: ComposerShellMetrics.actionHitEdge,
                               height: ComposerShellMetrics.actionHitEdge)
                        .background(Color.red.opacity(0.12), in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!online)
                .help(L10n("Stop current run"))
                .accessibilityLabel(L10n("Stop current run"))
                .accessibilityIdentifier("conversation-stop")
            }
        }
    }
}
