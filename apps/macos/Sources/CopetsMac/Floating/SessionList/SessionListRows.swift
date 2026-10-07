import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum SessionDisplayMode: String {
    case cards
    case compact
}

struct SessionProjectGroup: Identifiable {
    let id: String
    let path: String
    let rows: [SessionRowModel]
}

struct SessionListRowContent: View {
    @ObservedObject var row: SessionRowModel
    let displayMode: SessionDisplayMode
    let showsProjectName: Bool
    let isHiddenForReorder: Bool
    let hoverPreviewChanged: (String, Bool) -> Void

    var body: some View {
        Group {
            if displayMode == .compact {
                CompactSessionRow(
                    session: row.session,
                    showsProjectName: showsProjectName
                )
            } else {
                TaskCardView(
                    session: row.session,
                    showsProjectName: showsProjectName,
                    hoverPreviewChanged: hoverPreviewChanged
                )
            }
        }
        .opacity(isHiddenForReorder ? 0 : 1)
    }
}

struct DetailSessionRailRow: View {
    @ObservedObject var row: SessionRowModel
    let selectedSessionID: String?
    let select: (TaskSession) -> Void

    private var session: TaskSession { row.session }
    private var isSelected: Bool { selectedSessionID == row.id }

    var body: some View {
        Button {
            select(session)
        } label: {
            VStack(spacing: 2) {
                SessionAvatarView(session: session, avatarSize: isSelected ? 38 : 34)
                    .frame(width: 58, height: 58)
                    .background {
                        if isSelected {
                            Circle().fill(Color.white.opacity(0.22))
                            Circle().strokeBorder(Color.white.opacity(0.48), lineWidth: 1)
                        }
                    }

                Text(session.title)
                    .font(.system(size: 10, weight: isSelected ? .semibold : .medium, design: .rounded))
                    .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(width: 64)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(session.title)\n\(session.executionTaskStatus.label)")
    }
}

struct ProjectGroupHeader: View {
    let path: String
    let count: Int

    private var name: String {
        guard path != "No Project" else { return L10n("No Project") }
        return URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
    }

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: path == "No Project" ? "folder.badge.questionmark" : "folder.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.amber)
            Text(name)
                .font(.system(size: 11.5, weight: .semibold))
                .lineLimit(1)
            Text("\(count)")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(CorptiePalette.mutedText)
            Spacer()
        }
        .foregroundStyle(CorptiePalette.secondaryText)
        .padding(.horizontal, 9)
        .help(path)
    }
}

struct CompactSessionRowStyle {
    let height: CGFloat
    let titleWeight: Font.Weight

    static let standard = Self(height: 46, titleWeight: .semibold)
    static let sessionsSidebar = Self(height: 38, titleWeight: .bold)
    static let sessionsSidebarWithSubtitle = Self(height: 44, titleWeight: .bold)
}

struct CompactSessionRow: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isRenaming = false
    let session: TaskSession
    var isUnread = false
    var showsProjectName = true
    var style: CompactSessionRowStyle = .standard
    var displayTitle: String? = nil
    var subtitle: String? = nil
    var selectionRequested: ((TaskSession) -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            SessionStatusLight(status: session.executionTaskStatus, diameter: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(displayTitle ?? session.title)
                    .font(.system(size: 12.5, weight: style.titleWeight))
                    .lineLimit(1)
                    .help(session.title)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .layoutPriority(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 4)
            if isUnread {
                Circle()
                    .fill(Color.red)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel(L10n("Unread Session"))
                    .help(L10n("Unread Session"))
            }
        }
        .padding(.horizontal, 10)
        .frame(height: style.height)
        .standardSessionCardSurface()
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture {
            if let selectionRequested {
                selectionRequested(session)
            } else {
                backendClient.select(session: session, focusComposer: true)
            }
        }
        .contextMenu {
            SessionContextMenuContent(session: session, isRenaming: $isRenaming)
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) { isRenaming = false }
                .environmentObject(backendClient)
                .presentationBackground(.clear)
        }
    }

}

struct SessionIdentityLine: View {
    let session: TaskSession
    var showsProjectName = false
    var fontSize: CGFloat = 10

    var body: some View {
        HStack(spacing: 6) {
            SessionProviderIdentity(session: session)

            if let branchName {
                HStack(spacing: 2) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(branchName)
                        .fontDesign(.monospaced)
                        .truncationMode(.middle)
                }
                .foregroundStyle(CorptiePalette.secondaryText)
                .lineLimit(1)
                .layoutPriority(1)
                .help(branchName)
            }

            if showsProjectName, let projectName {
                HStack(spacing: 2) {
                    Image(systemName: "folder")
                    Text(projectName)
                }
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
                    .help(projectPath ?? projectName)
            }
        }
        .font(.system(size: fontSize, weight: .semibold))
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
    }

    private var branchName: String? {
        normalized(session.external?.workspace?.branchName)
    }

    private var projectPath: String? {
        normalized(session.external?.workspace?.projectPath)
            ?? normalized(session.external?.cwd)
    }

    private var projectName: String? {
        projectPath.map { URL(fileURLWithPath: $0).standardizedFileURL.lastPathComponent }
    }

    private func normalized(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }
}

struct SessionProviderIdentity: View {
    @ObservedObject private var modelCatalog = BackendClient.shared.modelCatalog
    let session: TaskSession
    var prominentText = false

    var body: some View {
        HStack(spacing: 2) {
            if let icon = ProviderBrandIcon.image(
                for: session.external?.provider ?? session.agent,
                providers: modelCatalog.agentProviders
            ) {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 13, height: 13)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: "cpu")
                    .foregroundStyle(session.accent.color)
                    .accessibilityHidden(true)
            }
            Text(sessionProviderIdentityLabel(
                providerIdentity: session.external?.provider,
                legacyAgentLabel: session.agent,
                providers: modelCatalog.agentProviders
            ))
            .foregroundStyle(prominentText ? Color.primary : session.accent.color)
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}

@MainActor
enum ProviderBrandIcon {
    // Bundled local copies of the Codex app icon (Product Hunt listing), the
    // Anthropic-published Claude Code VS Code icon, and OpenClacky's project icon.
    // Decode once per Provider so session-list scrolling does not reload images.
    private static let codex = load("codex")
    private static let claudeCode = load("claude-code")
    private static let openClacky = load("openclacky")

    static func assetName(for identity: String?, providers: [AgentProviderDescriptor]) -> String? {
        let canonical = providers.canonicalProviderId(for: identity)
            ?? identity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch canonical?.lowercased() {
        case "codex-app-server", "codex": return "codex"
        case "claude-sdk", "claude", "claude-code", "claude_code", "claude code": return "claude-code"
        case "openclacky", "clacky", "open-clacky": return "openclacky"
        default: return nil
        }
    }

    static func image(for identity: String?, providers: [AgentProviderDescriptor]) -> NSImage? {
        switch assetName(for: identity, providers: providers) {
        case "codex": return codex
        case "claude-code": return claudeCode
        case "openclacky": return openClacky
        default: return nil
        }
    }

    private static func load(_ name: String) -> NSImage? {
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "png",
            subdirectory: "ProviderIcons"
        ) else { return nil }
        return NSImage(contentsOf: url)
    }
}

func sessionProviderIdentityLabel(
    providerIdentity: String?,
    legacyAgentLabel: String,
    providers: [AgentProviderDescriptor]
) -> String {
    let identity = providerIdentity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !identity.isEmpty else { return legacyAgentLabel }
    return providers.displayName(for: identity) ?? identity
}

struct SessionContextMenuContent: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController

    let session: TaskSession
    @Binding var isRenaming: Bool

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
            Label(L10n("Settings…"), systemImage: "gearshape")
        }

        if let agentID = session.agentId {
            Button {
                NotificationCenter.default.post(
                    name: .showAgentOrb,
                    object: nil,
                    userInfo: ["agentId": agentID]
                )
            } label: {
                Label(L10n("Show Floating Orb"), systemImage: "circle.circle")
            }
        }

        Button {
            backendClient.restart(session: session)
        } label: {
            Label(L10n("Restart Session"), systemImage: "arrow.clockwise")
        }
        .disabled(session.actions?.restart?.available != true
            || backendClient.restartingSessionIds.contains(session.id))

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
            Label(L10n("Delete"), systemImage: "trash")
        }
    }
}
