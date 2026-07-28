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
        let content = SessionSettingsView(session: session, backendClient: backendClient) {
            [weak backendClient] sandbox, approvalPolicy in
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
            contentRect: NSRect(x: 0, y: 0, width: 470, height: 480),
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
    @State private var completionSoundId: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var workspaceHistory: [SessionWorkspaceHistory] = []
    @State private var isLoadingWorkspaceHistory = false

    let session: TaskSession
    @ObservedObject var backendClient: BackendClient
    let save: (String, String) async -> Bool

    init(
        session: TaskSession,
        backendClient: BackendClient,
        save: @escaping (String, String) async -> Bool
    ) {
        self.session = session
        self.backendClient = backendClient
        self.save = save
        _sandbox = State(initialValue: session.external?.sandbox ?? "workspace-write")
        _approvalPolicy = State(initialValue: session.external?.approvalPolicy ?? "on-request")
        _completionSoundId = State(
            initialValue: SessionCompletionSoundManager.selectedSoundId(for: session.id)
        )
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

            Divider()

            Grid(alignment: .leading, horizontalSpacing: 18) {
                GridRow {
                    Label(L10n("Completion Sound"), systemImage: "speaker.wave.2")
                        .fontWeight(.semibold)

                    HStack(spacing: 8) {
                        Picker("", selection: $completionSoundId) {
                            ForEach(SessionCompletionSoundManager.options) { option in
                                Text(L10n(option.label)).tag(option.id)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: .infinity)

                        Button {
                            SessionCompletionSoundManager.previewSound(completionSoundId)
                        } label: {
                            Label(L10n("Preview"), systemImage: "play.fill")
                        }
                        .disabled(selectedSoundOption.systemSoundName == nil)
                        .help(L10n("Preview the selected completion sound"))
                    }
                }
            }
            .onChange(of: completionSoundId) { _, soundId in
                SessionCompletionSoundManager.setSelectedSoundId(soundId, for: session.id)
            }

            if session.external?.provider == "codex-app-server" {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label(L10n("Workspace History"), systemImage: "point.3.connected.trianglepath.dotted")
                            .fontWeight(.semibold)
                        Spacer()
                        if isLoadingWorkspaceHistory {
                            ProgressView().controlSize(.small)
                        }
                    }
                    if session.external?.workspace?.transitionStrategy == "handoff" {
                        Label(
                            L10n("The active thread was created through a context handoff."),
                            systemImage: "arrow.triangle.branch"
                        )
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    }
                    Label(
                        L10n("Commands and terminals started by previous threads remain attached to their original workspace."),
                        systemImage: "terminal"
                    )
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    if workspaceHistory.isEmpty && !isLoadingWorkspaceHistory {
                        Text(L10n("No previous workspace threads."))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 6) {
                                ForEach(workspaceHistory) { entry in
                                    workspaceHistoryRow(entry)
                                }
                            }
                        }
                        .frame(maxHeight: 105)
                    }
                }
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
        .frame(width: 470, height: 480)
        .task {
            guard session.external?.provider == "codex-app-server" else { return }
            isLoadingWorkspaceHistory = true
            workspaceHistory = await backendClient.workspaceHistory(for: session)
            isLoadingWorkspaceHistory = false
        }
    }

    private var selectedSoundOption: SessionCompletionSoundOption {
        SessionCompletionSoundManager.option(for: completionSoundId)
    }

    private var supportsPermissionChanges: Bool {
        session.external?.provider == "codex-app-server"
    }

    @ViewBuilder
    private func workspaceHistoryRow(_ entry: SessionWorkspaceHistory) -> some View {
        HStack(spacing: 8) {
            Image(systemName: entry.readOnly ? "clock" : "circle.fill")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(entry.readOnly ? .secondary : CorptiePalette.connected)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.branchName ?? L10n("Detached or non-branch workspace"))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                Text(entry.boundCwd)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            if entry.readOnly {
                Button(L10n("Open Read Only")) {
                    Task {
                        if await backendClient.openHistoricalThread(entry, for: session) {
                            NSApp.activate(ignoringOtherApps: true)
                        }
                    }
                }
                .controlSize(.small)
            } else {
                Text(L10n("Active"))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(CorptiePalette.connected)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
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
