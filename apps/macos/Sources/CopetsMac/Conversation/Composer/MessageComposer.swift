import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerMentionCandidate: Identifiable {
    let mention: ConversationMention
    let detail: String
    let symbol: String

    var id: String { mention.id }
}

enum ComposerMentionCommand {
    case move(Int)
    case select
    case dismiss
}

typealias ComposerMentionMenuMetrics = CorptieConversation.ComposerMentionMenuMetrics

enum ComposerMentionAnchorPolicy {
    static let fallback = UnitPoint(x: 0.05, y: 0)

    static func point(
        for characterRect: CGRect,
        in viewportBounds: CGRect,
        viewportIsFlipped: Bool
    ) -> UnitPoint {
        guard viewportBounds.width > 0, viewportBounds.height > 0 else { return fallback }
        let x = (characterRect.midX - viewportBounds.minX) / viewportBounds.width
        let characterTop = viewportIsFlipped ? characterRect.minY : characterRect.maxY
        let y = viewportIsFlipped
            ? (characterTop - viewportBounds.minY) / viewportBounds.height
            : (viewportBounds.maxY - characterTop) / viewportBounds.height
        return UnitPoint(
            x: min(max(x, 0), 1),
            y: min(max(y, 0), 1)
        )
    }
}

struct MessageComposer: View {
    private static let sendControlEdge: CGFloat = 22

    @ObservedObject private var archivedSessionState = BackendClient.shared.archivedSessionController
    @ObservedObject private var modelCatalog: ProviderCatalogStore
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var appState = AppStateStore.shared
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    let sessionId: String
    let draftRepository: ComposerDraftRepository
    let allowsModelSwitch: Bool
    let status: TaskStatus?
    let isReady: Bool
    let notReadyReason: SessionNotReadyReason?
    let activityStatus: String?
    @FocusState private var isFocused: Bool
    @State private var composerWidth: CGFloat = 0
    @State private var inputHeight = ComposerInputLayout.minimumHeight
    @State private var editorController: ComposerEditorController
    @State private var hasSendableText: Bool
    @State private var isShowingScheduleSheet = false
    @State private var scheduleSubmission: ComposerDraftBuffer.Submission?
    @State private var attachedImages: [ChatImageReference] = []
    @State private var isImportingImages = false
    @State private var isShowingPhotoPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var mentionQuery: ComposerMentionQuery?
    @State private var mentionAnchorPoint = ComposerMentionAnchorPolicy.fallback
    @State private var mentionSelectionIndex = 0
    @State private var selectedMentions: [ConversationMention] = []
    @State private var quickMessages = ClientQuickMessage.defaults
    @State private var quickMessageRefresh = 0
    @State private var quickMessageScope = ""

    init(
        sessionId: String,
        draftRepository: ComposerDraftRepository,
        modelCatalog: ProviderCatalogStore,
        allowsModelSwitch: Bool = true,
        status: TaskStatus?,
        isReady: Bool,
        notReadyReason: SessionNotReadyReason?,
        activityStatus: String?
    ) {
        self.sessionId = sessionId
        _modelCatalog = ObservedObject(wrappedValue: modelCatalog)
        self.draftRepository = draftRepository
        self.allowsModelSwitch = allowsModelSwitch
        self.status = status
        self.isReady = isReady
        self.notReadyReason = notReadyReason
        self.activityStatus = activityStatus
        let draft = draftRepository.draft(for: sessionId)
        draft.sessionId = sessionId
        _attachedImages = State(initialValue: draft.images)
        _selectedMentions = State(initialValue: draft.mentions)
        _editorController = State(initialValue: ComposerEditorController(draft: draft))
        _hasSendableText = State(initialValue: draft.hasSendableText)
        let taskID = BackendClient.shared.sessions.first(where: { $0.id == sessionId })?.taskId
            ?? BackendClient.shared.archivedSessions.first(where: { $0.id == sessionId })?.taskId
        let scope = ClientQuickMessageCache.scope(host: BackendClient.shared.baseURL.absoluteString,
            taskID: taskID, sessionID: sessionId)
        _quickMessages = State(initialValue: BackendClient.quickMessageCache.items(for: scope))
        _quickMessageScope = State(initialValue: scope)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ConversationQuickMessages(items: quickMessages,
                enabled: canSend && !backendClient.isSendingMessage && session?.archived != true) { text in
                guard canSend, !backendClient.isSendingMessage, let session, session.archived != true else { return }
                // Independent send: never clear or attach the editor's draft.
                backendClient.sendMessage(text, to: session, onSuccess: { quickMessageRefresh += 1 })
            }
        ConversationComposerChrome {
            HStack(spacing: 0) {
                ThreadMetaView(sessionID: sessionId, status: status, isReady: isReady,
                               notReadyReason: notReadyReason, activityStatus: activityStatus)
                    .frame(maxWidth: .infinity, alignment: .leading)
                SessionComposerStopButton(session: session)
            }
        } content: {
            editorRow
        }
        }
        .task(id: "\(session?.taskId ?? sessionId):\(sessionId):\(quickMessageRefresh)") {
            let taskID = session?.taskId
            let scope = ClientQuickMessageCache.scope(host: backendClient.baseURL.absoluteString,
                taskID: taskID, sessionID: sessionId)
            if quickMessageScope != scope {
                quickMessages = BackendClient.quickMessageCache.items(for: scope)
                quickMessageScope = scope
            }
            do {
                let result = try await backendClient.quickMessages(for: sessionId)
                guard !Task.isCancelled, quickMessageScope == scope,
                      taskID == nil || result.taskId == taskID else { return }
                let resolvedScope = ClientQuickMessageCache.scope(host: backendClient.baseURL.absoluteString,
                    taskID: result.taskId, sessionID: sessionId)
                let items = BackendClient.quickMessageCache.remember(result.items, for: resolvedScope)
                // Also retain the Session fallback while inventory is loading.
                if resolvedScope != scope { BackendClient.quickMessageCache.remember(items, for: scope) }
                if quickMessages != items { quickMessages = items }
            } catch {
                // Recreated composers and transient disconnects retain the last good snapshot.
            }
        }
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: ComposerWidthPreferenceKey.self, value: proxy.size.width)
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .consoleComposerFocusRequested)) { notification in
            if notification.object as? String == sessionId { editorController.focusIfRequested() }
        }
        .onChange(of: attachedImages) { _, images in editorController.draft.images = images }
        .photosPicker(
            isPresented: $isShowingPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: max(1, 8 - attachedImages.count),
            matching: .images,
            preferredItemEncoding: .current
        )
        .onChange(of: selectedPhotoItems) { _, items in importPhotoItems(items) }
        .onChange(of: selectedMentions) { _, mentions in editorController.draft.mentions = mentions }
        .onPreferenceChange(ComposerWidthPreferenceKey.self) { width in composerWidth = width }
        .task {
            guard allowsModelSwitch,
                  backendClient.selectedSession?.id == sessionId else { return }
            let provider = backendClient.selectedSession?.external?.provider ?? "codex-pty"
            if modelCatalog.codexModels.isEmpty || modelCatalog.loadedModelProvider != provider {
                await backendClient.loadModelsForSelectedSession()
            }
        }
        .sheet(isPresented: $isShowingScheduleSheet) {
            if let session {
                ScheduledTaskEditorSheet(
                    session: session,
                    initialMessage: scheduleSubmission?.text ?? "",
                    onSaved: clearScheduledSubmissionIfUnchanged
                )
                .environmentObject(backendClient)
            }
        }
    }

    private var editorRow: some View {
        ConversationComposerEditorRow(
            showsAttachments: !attachedImages.isEmpty,
            showsModel: allowsModelSwitch && canSwitchModel
        ) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: ComposerShellMetrics.attachmentSpacing) {
                    ForEach(attachedImages) { image in
                        ComposerImageChip(
                            imageURL: backendClient.chatImageURL(sessionID: sessionId, managedPath: image.managedPath),
                            onRemove: { removeAttachedImage(image) }
                        )
                    }
                }
                .padding(.horizontal, 9)
                .padding(.top, 8)
                .padding(.bottom, 4)
            }
            .frame(height: ComposerShellMetrics.attachmentStripHeight)
        } editor: {
                ComposerInputTextView(
                    controller: editorController,
                    placeholder: "Send a instruction",
                    font: .systemFont(ofSize: 12, weight: .medium),
                    onFocusChange: { isFocused = $0 },
                    onSendableTextChange: { nextValue in
                        if hasSendableText != nextValue {
                            hasSendableText = nextValue
                        }
                    },
                    onContentHeightChange: { nextHeight in
                        if abs(inputHeight - nextHeight) > 0.5 {
                            inputHeight = nextHeight
                        }
                    },
                    onPasteImages: importImagesFromPasteboard,
                    onMentionQueryChange: updateMentionQuery,
                    onMentionAnchorChange: { mentionAnchorPoint = $0 },
                    onMentionCommand: handleMentionCommand,
                    onSubmit: send
                )
                .frame(height: inputHeight)
                .popover(isPresented: mentionMenuPresented,
                         attachmentAnchor: .point(mentionAnchorPoint), arrowEdge: .bottom) {
                    ComposerMentionMenu(candidates: mentionCandidates,
                                        selectedIndex: mentionSelectionIndex, onSelect: selectMention)
                        .frame(width: ComposerMentionMenuMetrics.width,
                               height: ComposerMentionMenuMetrics.height(candidateCount: mentionCandidates.count))
                }
                .onTapGesture { isFocused = true }
        } send: {
            Button { sendCurrentDraft() } label: {
                ComposerActionGlyph(systemName: "paperplane.fill", tint: ComposerPalette.softBlue,
                                    isBusy: backendClient.isSendingMessage, showsSurface: false)
                    .frame(width: Self.sendControlEdge, height: Self.sendControlEdge)
                    .clipped()
                    .overlay {
                        Circle().strokeBorder(ComposerPalette.softBlue.opacity(0.4), lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                    .conversationGlassControl(tint: ComposerPalette.softBlue)
                    .frame(width: ComposerShellMetrics.actionHitEdge,
                           height: ComposerShellMetrics.actionHitEdge)
                    .contentShape(Circle().inset(by: -8))
            }
            .buttonStyle(.plain)
            .disabled(isSendDisabled)
            .help(L10n("Send instruction"))
            .accessibilityLabel(L10n("Send instruction"))
            .accessibilityIdentifier("conversation-composer-send")
        } more: {
            Menu {
                Button {
                    isShowingPhotoPicker = true
                } label: {
                    Label(isImportingImages ? L10n("正在导入图片…") : L10n("从照片选择"),
                          systemImage: "photo.on.rectangle")
                }
                .disabled(!canAttachImages || isImportingImages || attachedImages.count >= 8)
                Button(action: chooseImageFiles) {
                    Label(L10n("从文件选择"), systemImage: "folder")
                }
                .disabled(!canAttachImages || isImportingImages || attachedImages.count >= 8)
                Button {
                    scheduleSubmission = editorController.submission()
                    isShowingScheduleSheet = true
                } label: {
                    Label(L10n("创建定时消息"), systemImage: ScheduledSessionAccessibilityID.composerSymbol)
                }
                .accessibilityIdentifier(ScheduledSessionAccessibilityID.composerEntry)
            } label: {
                ComposerActionGlyph(systemName: "ellipsis", tint: ComposerPalette.secondaryText,
                                    weight: .semibold, showsSurface: false)
                    .contentShape(Circle().inset(by: -8))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
            .fixedSize()
            .help(L10n("更多功能"))
            .accessibilityLabel(L10n("更多功能"))
            .accessibilityIdentifier("composer.more-actions")
        } model: {
            CodexModelMenu(modelCatalog: modelCatalog, maxWidth: modelMenuMaxWidth)
        }
        .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: nil) { providers in
            importDroppedImages(providers)
        }
    }

    private func sendCurrentDraft() {
        guard let submission = editorController.submission()
                ?? (!attachedImages.isEmpty
                    ? ComposerDraftBuffer.Submission(
                        text: editorController.draft.text,
                        revision: editorController.draft.revision
                    )
                    : nil) else {
            return
        }
        send(submission)
    }

    private func clearScheduledSubmissionIfUnchanged() {
        guard let scheduleSubmission else { return }
        if editorController.clear(ifUnchangedSince: scheduleSubmission) {
            hasSendableText = false
            inputHeight = ComposerInputLayout.minimumHeight
        }
        self.scheduleSubmission = nil
    }

    private func send(_ submission: ComposerDraftBuffer.Submission) {
        guard let session,
              canSend,
              !backendClient.isSendingMessage else {
            return
        }
        let submittedImages = attachedImages
        let submittedMentions = selectedMentions.filter { submission.text.contains("@\($0.displayName)") }
        let didStartSending = backendClient.sendMessage(submission.text, to: session,
            images: submittedImages,
            mentions: submittedMentions,
            onSuccess: { quickMessageRefresh += 1 },
            onFailure: {
            if editorController.restoreAfterFailedSubmission(submission) {
                hasSendableText = true
            }
            attachedImages = submittedImages
            selectedMentions = submittedMentions
        })
        guard didStartSending else {
            return
        }
        if editorController.clear(ifUnchangedSince: submission) {
            hasSendableText = false
            inputHeight = ComposerInputLayout.minimumHeight
        }
        attachedImages = []
        selectedMentions = []
        mentionQuery = nil
    }

    private var mentionCandidates: [ComposerMentionCandidate] {
        guard let mentionQuery else { return [] }
        let activeMentionIDs = Set(selectedMentions
            .filter { editorController.draft.text.contains("@\($0.displayName)") }
            .map(\.id))
        guard activeMentionIDs.count < 8 else { return [] }
        let needle = mentionQuery.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let availableSessions = appState.sessions.filter { $0.id != sessionId && $0.archived != true }
        let sessionsByWork = Dictionary(grouping: availableSessions, by: { $0.workId ?? "" })
        let workIDs = Set(appState.works.map(\.id))
        func sessionCandidate(_ candidate: TaskSession, workName: String?) -> ComposerMentionCandidate {
            ComposerMentionCandidate(
                mention: ConversationMention(targetType: .session, targetId: candidate.id, displayName: candidate.title),
                detail: workName.map { "Session · Work: \($0)" } ?? "Session",
                symbol: "bubble.left.and.bubble.right"
            )
        }
        var candidates: [ComposerMentionCandidate] = []
        for work in appState.works {
            candidates.append(ComposerMentionCandidate(
                mention: ConversationMention(targetType: .work, targetId: work.id, displayName: work.name),
                detail: L10n("Work"),
                symbol: "briefcase"
            ))
            candidates.append(contentsOf: (sessionsByWork[work.id] ?? []).map {
                sessionCandidate($0, workName: work.name)
            })
        }
        candidates.append(contentsOf: availableSessions.filter { !workIDs.contains($0.workId ?? "") }
            .map { sessionCandidate($0, workName: nil) })
        return candidates
            .filter { candidate in
                !activeMentionIDs.contains(candidate.id)
                    && (needle.isEmpty
                        || candidate.mention.displayName.localizedCaseInsensitiveContains(needle)
                        || candidate.mention.targetId.localizedCaseInsensitiveContains(needle)
                        || candidate.detail.localizedCaseInsensitiveContains(needle))
            }
    }

    private var mentionMenuPresented: Binding<Bool> {
        Binding(
            get: { mentionQuery != nil && !mentionCandidates.isEmpty },
            set: { isPresented in
                guard !isPresented else { return }
                mentionQuery = nil
                mentionSelectionIndex = 0
            }
        )
    }

    private func updateMentionQuery(_ query: ComposerMentionQuery?) {
        if query?.text != mentionQuery?.text {
            mentionSelectionIndex = 0
        }
        mentionQuery = query
    }

    private func handleMentionCommand(_ command: ComposerMentionCommand) -> Bool {
        guard mentionQuery != nil else { return false }
        switch command {
        case .move(let delta):
            guard !mentionCandidates.isEmpty else { return false }
            mentionSelectionIndex = (mentionSelectionIndex + delta + mentionCandidates.count) % mentionCandidates.count
        case .select:
            guard mentionCandidates.indices.contains(mentionSelectionIndex) else {
                mentionQuery = nil
                return false
            }
            selectMention(mentionCandidates[mentionSelectionIndex])
        case .dismiss:
            mentionQuery = nil
        }
        return true
    }

    private func selectMention(_ candidate: ComposerMentionCandidate) {
        guard let mentionQuery else { return }
        editorController.replaceMentionQuery(mentionQuery, with: candidate.mention.displayName)
        if !selectedMentions.contains(where: { $0.id == candidate.mention.id }) {
            selectedMentions.append(candidate.mention)
        }
        self.mentionQuery = nil
        mentionSelectionIndex = 0
        hasSendableText = true
        isFocused = true
    }


    private var isSendDisabled: Bool {
        return (!hasSendableText && attachedImages.isEmpty)
            || backendClient.isSendingMessage
            || !canSend
    }

    private var canSwitchModel: Bool {
        session?.actions?.switchModel.available
            ?? session?.capabilities?.canSwitchModel
            ?? (session?.agent == "Codex" ? true : false)
    }

    private var canAttachImages: Bool {
        session?.capabilities?.canSendImages == true
    }

    private func chooseImageFiles() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        importImageFiles(Array(panel.urls.prefix(max(0, 8 - attachedImages.count))), preserveOriginal: true)
    }

    private func importPhotoItems(_ items: [PhotosPickerItem]) {
        guard let session, !items.isEmpty else { return }
        let capacity = max(0, 8 - attachedImages.count)
        isImportingImages = true
        Task {
            defer {
                isImportingImages = false
                selectedPhotoItems = []
            }
            for item in items.prefix(capacity) {
                let temporaryURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("corptie-photo-\(UUID().uuidString).image")
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                    try data.write(to: temporaryURL, options: .atomic)
                    let image = try await backendClient.importChatImage(
                        at: temporaryURL,
                        to: session,
                        preserveOriginal: false
                    )
                    if !attachedImages.contains(image) { attachedImages.append(image) }
                } catch {
                    backendClient.presentChatImageError(error)
                }
                try? FileManager.default.removeItem(at: temporaryURL)
            }
        }
    }

    private func importImagesFromPasteboard(_ pasteboard: NSPasteboard) -> Bool {
        let urls = (pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: [UTType.image.identifier]
        ]) as? [URL]) ?? []
        if !urls.isEmpty {
            importImageFiles(urls, preserveOriginal: true)
            return true
        }
        guard let image = NSImage(pasteboard: pasteboard),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return false }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-paste-\(UUID().uuidString).png")
        do {
            try png.write(to: url, options: .atomic)
            importImageFiles([url], preserveOriginal: false, cleanupAfterImport: true)
            return true
        } catch {
            backendClient.presentChatImageError(error)
            return false
        }
    }

    private func importDroppedImages(_ providers: [NSItemProvider]) -> Bool {
        let capacity = max(0, 8 - attachedImages.count)
        let candidates = Array(providers.prefix(capacity))
        guard !candidates.isEmpty else { return false }
        for provider in candidates {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    let url = (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                        ?? item as? URL
                    guard let url else { return }
                    Task { @MainActor in importImageFiles([url], preserveOriginal: true) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent("corptie-drop-\(UUID().uuidString).image")
                    guard (try? data.write(to: url, options: .atomic)) != nil else { return }
                    Task { @MainActor in
                        importImageFiles([url], preserveOriginal: false, cleanupAfterImport: true)
                    }
                }
            }
        }
        return true
    }

    private func importImageFiles(
        _ urls: [URL],
        preserveOriginal: Bool,
        cleanupAfterImport: Bool = false
    ) {
        guard let session, !urls.isEmpty else { return }
        isImportingImages = true
        Task {
            defer { isImportingImages = false }
            for url in urls.prefix(max(0, 8 - attachedImages.count)) {
                do {
                    let image = try await backendClient.importChatImage(
                        at: url,
                        to: session,
                        preserveOriginal: preserveOriginal
                    )
                    if !attachedImages.contains(image) { attachedImages.append(image) }
                } catch {
                    backendClient.presentChatImageError(error)
                }
                if cleanupAfterImport { try? FileManager.default.removeItem(at: url) }
            }
        }
    }

    private func removeAttachedImage(_ image: ChatImageReference) {
        attachedImages.removeAll { $0.id == image.id }
        guard let session else { return }
        Task { await backendClient.removeUnsentChatImage(image, from: session) }
    }

    private var session: TaskSession? {
        backendClient.sessions.first(where: { $0.id == sessionId })
            ?? backendClient.archivedSessions.first(where: { $0.id == sessionId })
    }

    private var canSend: Bool {
        guard backendClient.isOnline,
              let session,
              session.isReady,
              !backendClient.bindingVerificationSessionIDs.contains(sessionId) else { return false }
        if backendClient.selectedSession?.id == sessionId,
           backendClient.viewingHistoricalThreadId != nil {
            return false
        }
        return session.actions?.send.available ?? true
    }

    private var modelMenuMaxWidth: CGFloat {
        ComposerShellMetrics.modelMenuMaxWidth(composerWidth: composerWidth)
    }
}

enum ComposerInputLayout {
    // Shared with the iPad composer; the AppKit editor only reports content height.
    static let minimumHeight = ComposerShellMetrics.minimumInputHeight
    static let maximumHeight = ComposerShellMetrics.maximumInputHeight

    static func resolvedHeight(for contentHeight: CGFloat) -> CGFloat {
        ComposerShellMetrics.resolvedInputHeight(for: contentHeight)
    }
}

private struct ComposerImageChip: View {
    let imageURL: URL?
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            AsyncImage(url: imageURL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    Image(systemName: phase.error == nil ? "photo" : "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 48, height: 48)
            .background(Color.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.66))
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .help(L10n("Remove image"))
        }
        .padding(.trailing, 3)
    }
}

struct ComposerGlassActionBackground: View {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let tint: Color

    var body: some View {
        if !isLiquidGlass {
            // 原生降级：简洁圆按钮
            Circle()
                .fill(tint.opacity(0.14))
        } else if #available(macOS 26.0, *) {
            Circle()
                .fill(.clear)
                .glassEffect(.clear.tint(tint.opacity(0.11)), in: .circle)
                .overlay {
                    Circle()
                        .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.6)
                }
                .overlay {
                    Circle()
                        .strokeBorder(tint.opacity(0.2), lineWidth: 0.6)
                }
        } else {
            Circle()
                .fill(.ultraThinMaterial)
                .overlay {
                    Circle()
                        .fill(tint.opacity(0.07))
                }
                .overlay {
                    Circle()
                        .strokeBorder(tint.opacity(0.2), lineWidth: 0.6)
                }
        }
    }
}

private struct ComposerWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
