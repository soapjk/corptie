import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ProjectWorktreeStatusChip: View {
    let status: ProjectWorktreeStatusResponse
    var showsSurface = true

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10, weight: .semibold))
            Text("\(status.project.pendingWorktreeCount)")
                .font(.system(size: 10, weight: .bold, design: .rounded))
        }
        .foregroundStyle(status.project.pendingWorktreeCount > 0 ? CorptiePalette.amber : CorptiePalette.secondaryText)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background {
            if showsSurface { Capsule().fill(Color.white.opacity(0.06)) }
        }
        .overlay {
            if showsSurface { Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75) }
        }
    }

}

struct ProjectServiceStatusDot: View {
    let status: ProjectServiceStatus

    var body: some View {
        Circle()
            .fill(serviceColor)
            .frame(width: 7, height: 7)
            .frame(width: 16, height: 28)
            .accessibilityLabel(accessibilityText)
    }

    private var serviceColor: Color {
        switch status.freshness {
        case "current": CorptiePalette.connected
        case "stale", "configurationMismatch", "unverifiedBuild", "toolsetUpdateRequired", "unhealthy": CorptiePalette.amber
        default: CorptiePalette.mutedText
        }
    }

    private var accessibilityText: String {
        switch status.freshness {
        case "current": return L10n("Service is running the latest code")
        case "stale": return L10n("Service is running older or modified code")
        case "configurationMismatch": return L10n("Service profile does not match the selected profile")
        case "unverifiedBuild": return L10n("Running build cannot be verified")
        case "toolsetUpdateRequired": return L10n("Update the project toolset to verify this service")
        case "unhealthy": return L10n("Service is running but unhealthy")
        case "stopped": return L10n("Service is stopped")
        default: return L10n("Service version is unknown")
        }
    }
}

@MainActor
final class ProjectWorktreeWindowManager {
    static let shared = ProjectWorktreeWindowManager()
    private var controller: ProjectWorktreeWindowController?

    func show(backendClient: BackendClient) {
        if let controller {
            controller.show()
            return
        }
        let controller = ProjectWorktreeWindowController(backendClient: backendClient) { [weak self] in
            self?.controller = nil
        }
        self.controller = controller
        controller.show()
    }

    func close() {
        controller?.close()
    }
}

@MainActor
private final class ProjectWorktreeWindowController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let didClose: () -> Void

    init(backendClient: BackendClient, didClose: @escaping () -> Void) {
        self.didClose = didClose
        let content = ProjectWorktreeManagerView()
            .environmentObject(backendClient)
        let hostingController = NSHostingController(rootView: content)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 500),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = L10n("Project Worktrees")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentViewController = hostingController
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 600, height: 430)
        panel.center()
        self.panel = panel
        super.init()
        panel.delegate = self
    }

    func show() {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        didClose()
    }
}

struct PendingWorktreeDeletion: Identifiable {
    let id = UUID()
    let worktree: ProjectWorktreeStatus
    let deleteSessions: Bool
    let restartService: Bool
}

enum ProjectWorktreeCleanupPolicy {
    static func eligibleWorktrees(from worktrees: [ProjectWorktreeStatus]) -> [ProjectWorktreeStatus] {
        worktrees.filter { worktree in
            !worktree.isMain
                && worktree.availability == "available"
                && worktree.mergedIntoMain == true
                && worktree.dirty == false
                && worktree.sessions.isEmpty
        }
    }
}

enum ProjectWorktreeIntegrationEntryState: Equatable {
    case ready
    case noEligibleWorktrees
    case unresolvedConflicts
    case running

    init(eligibleCount: Int, conflictCount: Int, isRunning: Bool) {
        if isRunning {
            self = .running
        } else if conflictCount > 0 {
            self = .unresolvedConflicts
        } else if eligibleCount == 0 {
            self = .noEligibleWorktrees
        } else {
            self = .ready
        }
    }
}

enum ProjectGitHubPushSelection {
    static func status(
        for worktree: ProjectWorktreeStatus?,
        fallback: GitHubPushStatus?
    ) -> GitHubPushStatus? {
        worktree?.gitHubPush ?? fallback
    }
}
