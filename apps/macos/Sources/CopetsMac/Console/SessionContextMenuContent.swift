import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct SessionContextMenuContent: View {
    @EnvironmentObject private var backendClient: BackendClient
    let session: TaskSession
    @Binding var isRenaming: Bool
    var usesExplicitTargetLabels = false
    var isRestartPending = false

    var body: some View {
        if session.allowsManualRename {
            Button {
                isRenaming = true
            } label: {
                Label(L10n("Rename"), systemImage: "pencil")
            }
        }

        Button {
            SessionSettingsWindowManager.shared.show(session: session, backendClient: backendClient)
        } label: {
            Label(usesExplicitTargetLabels ? L10n("Session Settings…") : L10n("Settings…"), systemImage: "gearshape")
        }

        DetachedChatWindowMenuButton(session: session)

        if let roleID = session.roleId {
            Button {
                NotificationCenter.default.post(
                    name: .showAgentOrb,
                    object: nil,
                    userInfo: ["agentId": roleID]
                )
            } label: {
                Label(L10n("Show Floating Orb"), systemImage: "circle.circle")
            }
        }

        SessionRestartMenuButton(commandState: backendClient.sessionCommandController, session: session,
            title: usesExplicitTargetLabels ? L10n("Restart This Session") : L10n("Restart Session"),
            isPending: isRestartPending) {
            backendClient.restart(session: session)
        }

        Divider()

        Button {
            backendClient.setPinned(session.pinned != true, session: session)
        } label: {
            Label(
                session.pinned == true ? L10n("Unpin") : L10n("Pin to Top"),
                systemImage: session.pinned == true ? "pin.slash" : "pin"
            )
        }

        if session.allowsManualArchive {
            Divider()

            Button {
                backendClient.setArchived(true, session: session)
            } label: {
                Label(L10n("Archive"), systemImage: "archivebox")
            }
        }

        Divider()

        Button(role: .destructive) {
            backendClient.delete(session: session)
        } label: {
            Label(usesExplicitTargetLabels ? L10n("Delete This Session…") : L10n("Delete"), systemImage: "trash")
        }
    }
}

/// Observe command progress only while rendering a menu, not the whole navigation tree.
struct SessionRestartMenuButton: View {
    @ObservedObject var commandState: SessionCommandController
    let session: TaskSession?
    let title: String
    var isPending = false
    let restart: () -> Void

    var body: some View {
        Button(action: restart) {
            Label(title, systemImage: "arrow.clockwise")
        }
        .disabled(session?.actions?.restart?.available != true || isPending
            || session.map { commandState.restartingSessionIds.contains($0.id) } == true)
    }
}
