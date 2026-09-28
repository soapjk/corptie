import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct GitHubPushArrowAnimation {
    static let duration = 1.4
    static let progressSymbolName = "arrow.up"
    static let travelExtent = 20.0

    static func progress(at time: TimeInterval) -> Double {
        let remainder = time.truncatingRemainder(dividingBy: duration)
        return (remainder < 0 ? remainder + duration : remainder) / duration
    }

    static func verticalOffset(progress: Double) -> Double {
        let clamped = min(max(progress, 0), 1)
        return travelExtent - (travelExtent * 2 * clamped)
    }

    static func opacity(progress: Double) -> Double {
        let clamped = min(max(progress, 0), 1)
        if clamped < 0.25 {
            return clamped / 0.25
        }
        if clamped <= 0.55 {
            return 1
        }
        return (1 - clamped) / 0.45
    }
}

struct GitHubPushButtonAppearance {
    static let diameter = 28.0
    static let arrowFontSize = 12.0
    static let arrowOpacity = 1.0
}

struct GitHubPushButtonVisual: View {
    enum State: Equatable {
        case ready
        case preparing
        case pushing
    }

    let color: Color
    let state: State

    var body: some View {
        ZStack {
            switch state {
            case .ready:
                Image(systemName: GitHubPushArrowAnimation.progressSymbolName)
                    .font(.system(
                        size: GitHubPushButtonAppearance.arrowFontSize,
                        weight: .heavy
                    ))
                    .symbolRenderingMode(.monochrome)
                    .foregroundColor(color)
                    .opacity(GitHubPushButtonAppearance.arrowOpacity)
            case .preparing:
                ProgressView()
                    .controlSize(.small)
                    .tint(color)
            case .pushing:
                GitHubPushProgressIcon(color: color)
            }
        }
        .frame(
            width: GitHubPushButtonAppearance.diameter,
            height: GitHubPushButtonAppearance.diameter
        )
        .background { ComposerGlassActionBackground(tint: color) }
    }
}

struct GitHubPushDisclosure {
    struct ChangeGroups: Equatable {
        let added: [String]
        let modified: [String]
        let deleted: [String]
    }

    static func changeGroups(
        addedFiles: [String],
        modifiedFiles: [String],
        deletedFiles: [String],
        changedFiles: [String],
        protectedPaths: [String],
        ignoringProtectedFiles: Bool
    ) -> ChangeGroups {
        guard ignoringProtectedFiles else {
            return ChangeGroups(added: addedFiles, modified: modifiedFiles, deleted: deletedFiles)
        }
        let normalizedChangedPaths = Set(changedFiles.map(normalize))
        let normalizedProtectedPaths = protectedPaths.map(normalize)
        func filtered(_ values: [String]) -> [String] {
            values.filter { path in
                let normalizedPath = normalize(path)
                guard normalizedChangedPaths.contains(normalizedPath) else { return true }
                return !normalizedProtectedPaths.contains { protectedPath in
                    protectedPath == normalizedPath || protectedPath.hasPrefix("\(normalizedPath)/")
                }
            }
        }
        var added = filtered(addedFiles)
        var modified = filtered(modifiedFiles)
        let deleted = filtered(deletedFiles)
        if !added.contains(".gitignore") && !modified.contains(".gitignore") {
            modified.append(".gitignore")
        }
        added = Array(Set(added)).sorted()
        modified = Array(Set(modified)).sorted()
        return ChangeGroups(added: added, modified: modified, deleted: Array(Set(deleted)).sorted())
    }

    static func filesToPush(
        filesToPush: [String],
        changedFiles: [String],
        protectedPaths: [String],
        ignoringProtectedFiles: Bool
    ) -> [String] {
        guard ignoringProtectedFiles else { return filesToPush }
        let normalizedChangedPaths = Set(changedFiles.map(normalize))
        let normalizedProtectedPaths = protectedPaths.map(normalize)
        let disclosed = filesToPush.filter { path in
            let normalizedPath = normalize(path)
            guard normalizedChangedPaths.contains(normalizedPath) else { return true }
            return !normalizedProtectedPaths.contains { protectedPath in
                protectedPath == normalizedPath || protectedPath.hasPrefix("\(normalizedPath)/")
            }
        }
        return Array(Set(disclosed + [".gitignore"])).sorted()
    }

    private static func normalize(_ path: String) -> String {
        var normalized = path
        while normalized.hasPrefix("/") { normalized.removeFirst() }
        while normalized.hasSuffix("/") { normalized.removeLast() }
        return normalized
    }
}

private struct GitHubPushProgressIcon: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let color: Color

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            let progress = GitHubPushArrowAnimation.progress(
                at: context.date.timeIntervalSinceReferenceDate
            )
            Image(systemName: GitHubPushArrowAnimation.progressSymbolName)
                .font(.system(
                    size: GitHubPushButtonAppearance.arrowFontSize,
                    weight: .heavy
                ))
                .symbolRenderingMode(.monochrome)
                .foregroundColor(color)
                .offset(y: reduceMotion ? 0 : GitHubPushArrowAnimation.verticalOffset(progress: progress))
                .opacity(reduceMotion
                    ? GitHubPushButtonAppearance.arrowOpacity
                    : GitHubPushArrowAnimation.opacity(progress: progress))
        }
        .frame(
            width: GitHubPushButtonAppearance.diameter,
            height: GitHubPushButtonAppearance.diameter
        )
        .clipShape(Circle())
        .accessibilityLabel(L10n("Pushing to GitHub…"))
    }
}

private struct GitHubPushConfirmationView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var gitHubPushState = BackendClient.shared.gitHubPushController
    let preparation: GitHubPushPreparation
    @State private var privateFilesDecision = "include"
    @State private var neverRemindPrivateFiles = false
    @State private var commitMessage = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(preparation.dirty ? CorptiePalette.amber : CorptiePalette.connected)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Review GitHub Push"))
                        .font(.system(size: 18, weight: .bold))
                    Text(preparation.repository)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                disclosureRow(L10n("Destination"), value: preparation.remoteUrl)
                disclosureRow(L10n("Branch"), value: preparation.branch)
                disclosureRow(L10n("Source code"), value: L10n("Included"))
                disclosureRow(
                    L10n("Visibility"),
                    value: L10n("Existing GitHub repository access settings; Corptie will not change visibility.")
                )
                disclosureRow(
                    L10n("Remote storage"),
                    value: L10n("Commits will remain in GitHub history until removed under repository and GitHub retention policies.")
                )
            }
            .padding(12)
            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
            )

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    disclosureList(
                        title: L10nFormat("Added files (%d)", disclosedChangeGroups.added.count),
                        values: disclosedChangeGroups.added,
                        icon: "plus.circle.fill",
                        color: CorptiePalette.connected
                    )
                    disclosureList(
                        title: L10nFormat("Modified files (%d)", disclosedChangeGroups.modified.count),
                        values: disclosedChangeGroups.modified,
                        icon: "pencil.circle.fill",
                        color: CorptiePalette.amber
                    )
                    disclosureList(
                        title: L10nFormat("Deleted files (%d)", disclosedChangeGroups.deleted.count),
                        values: disclosedChangeGroups.deleted,
                        icon: "minus.circle.fill",
                        color: .red
                    )
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L10nFormat("Commits sent to GitHub (%d)", preparation.commitsToPush.count))
                            .font(.system(size: 12, weight: .semibold))
                        if preparation.commitsToPush.isEmpty {
                            Text(L10n("No existing local commits are waiting to be pushed."))
                                .font(.system(size: 11))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            ForEach(preparation.commitsToPush, id: \.oid) { commit in
                                HStack(alignment: .firstTextBaseline, spacing: 7) {
                                    Text(String(commit.oid.prefix(8)))
                                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                                        .foregroundStyle(CorptiePalette.mutedText)
                                    Text(commit.subject)
                                        .font(.system(size: 11))
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 210)

            if preparation.dirty {
                CommitMessageEditor(
                    message: $commitMessage,
                    isGenerating: backendClient.isGeneratingGitHubCommitMessage,
                    helpText: L10n("Enter your own message or generate one with Agent, then edit it before pushing."),
                    generate: { await backendClient.generateGitHubCommitMessage() }
                )
            }

            if preparation.commitProtection?.requiresDecision == true,
               let protection = preparation.commitProtection {
                PrivateAgentFilesDecisionView(
                    protection: protection,
                    decision: $privateFilesDecision,
                    neverRemind: $neverRemindPrivateFiles
                )
            }

            if let error = backendClient.gitHubPushError {
                Text(error)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }

            HStack {
                Spacer()
                Button(L10n("Cancel")) {
                    backendClient.cancelGitHubPush()
                }
                .keyboardShortcut(.cancelAction)

                Button(preparation.dirty
                    ? L10n("Commit and Push to GitHub")
                    : L10n("Push to GitHub")) {
                    backendClient.confirmGitHubPush(
                        commitMessage: preparation.dirty
                            ? commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                            : nil,
                        privateFilesDecision: preparation.commitProtection?.requiresDecision == true
                            ? privateFilesDecision
                            : nil,
                        neverRemindPrivateFiles: neverRemindPrivateFiles
                    )
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    backendClient.isGeneratingGitHubCommitMessage
                        || (preparation.dirty
                            && commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                )
            }
        }
        .padding(20)
        .frame(width: 560, height: 710)
    }

    private func disclosureRow(_ title: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(width: 94, alignment: .leading)
            Text(value)
                .font(.system(size: 11, design: title == L10n("Destination") ? .monospaced : .default))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var disclosedChangeGroups: GitHubPushDisclosure.ChangeGroups {
        let hasStructuredChanges = preparation.addedFiles != nil
            || preparation.modifiedFiles != nil
            || preparation.deletedFiles != nil
        return GitHubPushDisclosure.changeGroups(
            addedFiles: preparation.addedFiles ?? [],
            modifiedFiles: preparation.modifiedFiles ?? (hasStructuredChanges ? [] : preparation.filesToPush),
            deletedFiles: preparation.deletedFiles ?? [],
            changedFiles: preparation.changedFiles,
            protectedPaths: preparation.commitProtection?.protectedPaths ?? [],
            ignoringProtectedFiles: privateFilesDecision == "ignore"
                && preparation.commitProtection?.requiresDecision == true
        )
    }

    @ViewBuilder
    private func disclosureList(title: String, values: [String], icon: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
            if values.isEmpty {
                Text(L10n("None"))
                    .font(.system(size: 11))
                    .foregroundStyle(CorptiePalette.secondaryText)
            } else {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(.system(size: 10.5, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
    }
}

struct CommitMessageEditor: View {
    @Binding var message: String
    let isGenerating: Bool
    let helpText: String
    let generate: () async -> String?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(L10n("Commit message"))
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Button {
                    Task {
                        if let suggestion = await generate() {
                            message = suggestion
                        }
                    }
                } label: {
                    if isGenerating {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(L10n("Generating…"))
                        }
                    } else {
                        Label(L10n("Generate with Agent"), systemImage: "wand.and.stars")
                    }
                }
                .disabled(isGenerating)
            }
            TextField(L10n("Enter a commit message"), text: $message)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
            Text(helpText)
                .font(.system(size: 10.5))
                .foregroundStyle(CorptiePalette.secondaryText)
        }
    }
}

@MainActor
final class GitHubPushConfirmationWindowManager {
    static let shared = GitHubPushConfirmationWindowManager()
    private var controller: GitHubPushConfirmationWindowController?

    func show(preparation: GitHubPushPreparation, backendClient: BackendClient) {
        if let controller {
            controller.show()
            return
        }
        let controller = GitHubPushConfirmationWindowController(
            preparation: preparation,
            backendClient: backendClient
        ) { [weak self] in
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
private final class GitHubPushConfirmationWindowController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let backendClient: BackendClient
    private let didClose: () -> Void

    init(
        preparation: GitHubPushPreparation,
        backendClient: BackendClient,
        didClose: @escaping () -> Void
    ) {
        self.backendClient = backendClient
        self.didClose = didClose
        let content = GitHubPushConfirmationView(preparation: preparation)
            .environmentObject(backendClient)
        let hostingController = NSHostingController(rootView: content)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 710),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = L10n("Review GitHub Push")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentViewController = hostingController
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
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

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        backendClient.cancelGitHubPush()
        return true
    }

    func windowWillClose(_ notification: Notification) {
        didClose()
    }
}
