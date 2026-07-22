import AppKit
import SwiftUI

@MainActor
final class SessionSettingsWindowManager {
    static let shared = SessionSettingsWindowManager()

    private var controllers: [String: SessionSettingsWindowController] = [:]

    func show(session: TaskSession, backendClient: BackendClient) {
        if let controller = controllers[session.id] {
            controller.show()
            return
        }
        let controller = SessionSettingsWindowController(
            session: session,
            backendClient: backendClient
        ) { [weak self] in
            self?.controllers.removeValue(forKey: session.id)
        }
        controllers[session.id] = controller
        controller.show()
    }
}

@MainActor
private final class SessionSettingsWindowCloseHandler {
    var close: () -> Void = {}
}

@MainActor
private final class SessionSettingsWindowController: NSObject, NSWindowDelegate {
    private let window: NSPanel
    private let didClose: () -> Void

    init(session: TaskSession, backendClient: BackendClient, didClose: @escaping () -> Void) {
        self.didClose = didClose
        let closeHandler = SessionSettingsWindowCloseHandler()
        let content = SessionSettingsView(session: session) { [weak backendClient] sandbox, approvalPolicy in
            guard let backendClient else { return false }
            let succeeded = await backendClient.updateSessionPermissions(
                session: session,
                sandbox: sandbox,
                approvalPolicy: approvalPolicy
            )
            if succeeded {
                closeHandler.close()
            }
            return succeeded
        }
        let hostingController = NSHostingController(rootView: content)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 280),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        panel.title = L10nFormat("Settings: %@", session.title)
        panel.contentViewController = hostingController
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.center()
        self.window = panel
        super.init()
        panel.delegate = self
        closeHandler.close = { [weak panel] in panel?.close() }
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        didClose()
    }
}

private struct SessionSettingsView: View {
    @State private var sandbox: String
    @State private var approvalPolicy: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    let session: TaskSession
    let save: (String, String) async -> Bool

    init(session: TaskSession, save: @escaping (String, String) async -> Bool) {
        self.session = session
        self.save = save
        _sandbox = State(initialValue: session.external?.sandbox ?? "workspace-write")
        _approvalPolicy = State(initialValue: session.external?.approvalPolicy ?? "on-request")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Text(session.external?.cwd ?? session.agent)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            if supportsPermissionChanges {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 12) {
                    GridRow {
                        Text(L10n("Permission"))
                            .fontWeight(.semibold)
                        Picker("", selection: $sandbox) {
                            Text(L10n("Workspace Write")).tag("workspace-write")
                            Text(L10n("Full Access")).tag("danger-full-access")
                            Text(L10n("Read Only")).tag("read-only")
                        }
                        .labelsHidden()
                    }
                    GridRow {
                        Text(L10n("Approvals"))
                            .fontWeight(.semibold)
                        Picker("", selection: $approvalPolicy) {
                            Text(L10n("Ask")).tag("on-request")
                            Text(L10n("Ask for Risky Actions")).tag("ask-risky")
                            Text(L10n("Never Ask")).tag("never")
                            Text(L10n("On Failure")).tag("on-failure")
                        }
                        .labelsHidden()
                    }
                }

                Label(L10n("Changes apply from the next instruction. The current run is not interrupted."), systemImage: "info.circle")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            } else {
                Label(
                    L10n("This session's permissions are fixed by its launch command and cannot be changed while it exists."),
                    systemImage: "lock.fill"
                )
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
            }

            Spacer()

            HStack {
                Spacer()
                Button(L10n("Save")) {
                    saveChanges()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!supportsPermissionChanges || isSaving)
            }
        }
        .padding(20)
        .frame(width: 390, height: 280)
    }

    private var supportsPermissionChanges: Bool {
        session.external?.provider == "codex-app-server"
    }

    private func saveChanges() {
        isSaving = true
        errorMessage = nil
        Task {
            let succeeded = await save(sandbox, approvalPolicy)
            await MainActor.run {
                isSaving = false
                if !succeeded {
                    errorMessage = L10n("Could not update this session's permissions.")
                }
            }
        }
    }
}
