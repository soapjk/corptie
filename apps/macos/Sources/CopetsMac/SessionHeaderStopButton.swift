import SwiftUI

/// Shared by the main chat, workspace card and detached chat header.
/// Uses the displayed Session, never the globally selected conversation.
struct SessionHeaderStopButton: View {
    @EnvironmentObject private var backendClient: BackendClient
    let session: TaskSession

    var body: some View {
        if session.executionTaskStatus == .running && session.canInterruptNow {
            Button {
                backendClient.interrupt(session: session, surface: .sessionDetailToolbar)
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.red)
                    .frame(width: 28, height: 28)
                    .background(Color.red.opacity(0.22), in: Circle())
                    .overlay {
                        Circle().strokeBorder(Color.red.opacity(0.45), lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                    .contentShape(Circle())
            }
            .buttonStyle(.borderless)
            .disabled(!backendClient.isOnline)
            .help(L10n("Stop current run"))
            .accessibilityLabel(L10n("Stop current run"))
            .accessibilityIdentifier("session.header.stop")
        }
    }
}
