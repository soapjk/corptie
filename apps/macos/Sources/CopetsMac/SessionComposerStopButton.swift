import SwiftUI
import CorptieConversation

/// Targets the displayed Session, including workspace cards and detached chats.
/// The reserved slot keeps usage and status text stable as execution starts/stops.
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
                        .frame(width: ComposerShellMetrics.actionVisualEdge,
                               height: ComposerShellMetrics.actionVisualEdge)
                        .conversationGlassControl(tint: .red)
                        .overlay {
                            Circle().strokeBorder(Color.red.opacity(0.45), lineWidth: 1)
                                .allowsHitTesting(false)
                        }
                        .frame(width: compact ? ComposerShellMetrics.actionHitEdge : 44,
                               height: compact ? ComposerShellMetrics.actionHitEdge : 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!online)
                .help(L10n("Stop current run"))
                .accessibilityLabel(L10n("Stop current run"))
                .accessibilityIdentifier("conversation-stop")
            }
        }
        .frame(width: compact ? ComposerShellMetrics.actionHitEdge : 44,
               height: compact ? ComposerShellMetrics.actionHitEdge : 32)
    }
}
