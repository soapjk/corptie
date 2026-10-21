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
    private static let sendControlEdge = ComposerShellMetrics.actionVisualEdge

    @ObservedObject private var archivedSessionState = BackendClient.shared.archivedSessionController
    @ObservedObject private var modelCatalog: ProviderCatalogStore
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var appState = AppStateStore.shared
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    let sessionId: String
    let draftRepository: ComposerDraftRepository
    let allowsModelSwitch: Bool
    let compact: Bool
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
    @State private var imageImportState = ComposerImageImportState()
    private var isImportingImages: Bool { imageImportState.busy }
    @State private var isShowingPhotoPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var mentionQuery: ComposerMentionQuery?
    @State private var mentionAnchorPoint = ComposerMentionAnchorPolicy.fallback
    @State private var mentionSelectionIndex = 0
    @State private var selectedMentions: [ConversationMention] = []
    @State private var quickMessageRefresh = 0

    init(
        sessionId: String,
        draftRepository: ComposerDraftRepository,
        modelCatalog: ProviderCatalogStore,
        allowsModelSwitch: Bool = true,
        compact: Bool = false,
        status: TaskStatus?,
        isReady: Bool,
        notReadyReason: SessionNotReadyReason?,
        activityStatus: String?
    ) {
        self.sessionId = sessionId
        _modelCatalog = ObservedObject(wrappedValue: modelCatalog)
        self.draftRepository = draftRepository
        self.allowsModelSwitch = allowsModelSwitch
        self.compact = compact
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
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !compact {
                MacComposerQuickMessages(host: backendClient.baseURL.absoluteString, sessionID: sessionId,
                    taskID: session?.taskId, online: backendClient.isOnline, refreshRevision: quickMessageRefresh,
                    enabled: canSend && !backendClient.isSendingMessage && session?.archived != true,
                    load: { try await backendClient.quickMessages(for: sessionId) }) { text in
                    guard canSend, !backendClient.isSendingMessage, let session, session.archived != true else { return }
                    // Independent send: never clear or attach the editor's draft.
                    backendClient.sendMessage(text, to: session, onSuccess: { quickMessageRefresh += 1 })
                }
            }
            if compact {
                compactEditorRow
                    .frame(maxWidth: CompactComposerLayout.maximumWidth)
            } else {
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
                .frame(maxWidth: .infinity)
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
        .onAppear { imageImportState.activate() }
        .onDisappear { imageImportState.invalidate() }
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
            attachmentStrip
        } editor: {
            editorInput
        } send: {
            sendButton
        } more: {
            moreMenu
        } model: {
            CodexModelMenu(modelCatalog: modelCatalog, maxWidth: modelMenuMaxWidth)
        }
        .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: nil) { providers in
            importDroppedImages(providers)
        }
    }

    private var compactEditorRow: some View {
        VStack(spacing: 0) {
            if !attachedImages.isEmpty { attachmentStrip }
            HStack(spacing: 2) {
                editorInput
                    .frame(minWidth: 0, maxWidth: .infinity)
                    .padding(.leading, 8)
                    .padding(.trailing, 2)
                    .layoutPriority(-1)
                sendButton
                if session?.executionTaskStatus == .running,
                   session?.canInterruptNow == true {
                    SessionComposerStopButton(session: session, compact: true)
                }
                moreMenu
                    .padding(.trailing, 4)
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: ComposerShellMetrics.cornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.22), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: nil) { providers in
            importDroppedImages(providers)
        }
    }

    private var attachmentStrip: some View {
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
    }

    private var sendButton: some View {
        Button { sendCurrentDraft() } label: {
            ComposerActionGlyph(systemName: "paperplane.fill", tint: ComposerPalette.softBlue,
                                isBusy: backendClient.isSendingMessage || isImportingImages, showsSurface: false)
                .frame(width: Self.sendControlEdge, height: Self.sendControlEdge)
                .clipped()
                .overlay {
                    Circle().strokeBorder(ComposerPalette.softBlue.opacity(0.4), lineWidth: 1)
                        .allowsHitTesting(false)
                }
                .conversationGlassControl(tint: ComposerPalette.softBlue)
                .frame(width: ComposerShellMetrics.actionHitEdge,
                       height: ComposerShellMetrics.actionHitEdge)
                .contentShape(Circle().inset(by: compact ? 0 : -8))
        }
        .buttonStyle(.plain)
        .disabled(isSendDisabled)
        .help(isImportingImages ? L10n("正在导入图片…") : L10n("Send instruction"))
        .accessibilityLabel(isImportingImages ? L10n("正在导入图片…") : L10n("Send instruction"))
        .accessibilityIdentifier("conversation-composer-send")
    }

    private var moreMenu: some View {
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
                .contentShape(Circle().inset(by: compact ? 0 : -8))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
        .fixedSize()
        .help(L10n("更多功能"))
        .accessibilityLabel(L10n("更多功能"))
        .accessibilityIdentifier("composer.more-actions")
    }

    private var editorInput: some View {
        ComposerInputTextView(
            controller: editorController,
            placeholder: "Send a instruction",
            font: .systemFont(ofSize: 12, weight: .medium),
            textInsetHeight: compact ? CompactComposerLayout.textInsetHeight : ComposerShellMetrics.textInsetHeight,
            onFocusChange: { isFocused = $0 },
            onSendableTextChange: { nextValue in
                if hasSendableText != nextValue { hasSendableText = nextValue }
            },
            onContentHeightChange: { nextHeight in
                let resolved = compact ? CompactComposerLayout.resolvedInputHeight(nextHeight) : nextHeight
                if abs(inputHeight - resolved) > 0.5 { inputHeight = resolved }
            },
            onPasteImages: importImagesFromPasteboard,
            onMentionQueryChange: updateMentionQuery,
            onMentionAnchorChange: { mentionAnchorPoint = $0 },
            onMentionCommand: handleMentionCommand,
            onSubmit: send
        )
        .frame(height: compact ? CompactComposerLayout.resolvedInputHeight(inputHeight) : inputHeight)
        .popover(isPresented: mentionMenuPresented,
                 attachmentAnchor: .point(mentionAnchorPoint), arrowEdge: .bottom) {
            ComposerMentionMenu(candidates: mentionCandidates,
                                selectedIndex: mentionSelectionIndex, onSelect: selectMention)
                .frame(width: ComposerMentionMenuMetrics.width,
                       height: ComposerMentionMenuMetrics.height(candidateCount: mentionCandidates.count))
        }
        .onTapGesture { isFocused = true }
        .accessibilityHint(compact ? L10n("Press Return to send; Shift-Return for a new line") : "")
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
              !isImportingImages,
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
            || isImportingImages
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
        let urls = panel.urls
        startImageImport { ComposerImagePasteboard.Snapshot(items: urls.prefix(9).map { [.file($0)] }) }
    }

    private func importPhotoItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        selectedPhotoItems = []
        startImageImport {
            var snapshot = ComposerImagePasteboard.Snapshot(items: [])
            var remainingBytes = ComposerImagePasteboard.maximumTotalBytes
            for item in items.prefix(9) {
                do {
                    try Task.checkCancellation()
                    guard let data = try await item.loadTransferable(type: Data.self),
                          data.count <= ComposerImagePasteboard.maximumBytes, data.count <= remainingBytes
                    else { snapshot.rejectedItems += 1; continue }
                    remainingBytes -= data.count
                    snapshot.items.append([.data(data)])
                } catch is CancellationError { throw CancellationError() }
                catch { snapshot.rejectedItems += 1 }
            }
            return snapshot
        }
    }

    private func importImagesFromPasteboard(_ pasteboard: NSPasteboard) -> Bool {
        guard let snapshot = ComposerImagePasteboard.capture(pasteboard) else { return false }
        startImageImport { snapshot }
        return true
    }

    private func importDroppedImages(_ providers: [NSItemProvider]) -> Bool {
        let candidates = Array(providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }.prefix(9))
        guard !candidates.isEmpty else { return false }
        startImageImport {
            var snapshot = ComposerImagePasteboard.Snapshot(items: [])
            var remainingBytes = ComposerImagePasteboard.maximumTotalBytes
            for provider in candidates {
                try Task.checkCancellation()
                var representations: [ComposerImagePasteboard.Representation] = []
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let url: URL? = await withCheckedContinuation { continuation in
                        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                            continuation.resume(returning: (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                                ?? item as? URL)
                        }
                    }
                    if let url, url.isFileURL { representations.append(.file(url)) }
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    let data: Data? = await withCheckedContinuation { continuation in
                        provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                            continuation.resume(returning: data)
                        }
                    }
                    if let data, data.count <= ComposerImagePasteboard.maximumBytes, data.count <= remainingBytes {
                        remainingBytes -= data.count
                        representations.append(.data(data))
                    }
                }
                if representations.isEmpty { snapshot.rejectedItems += 1 }
                else { snapshot.items.append(representations) }
            }
            return snapshot
        }
        return true
    }

    private func startImageImport(
        _ load: @escaping @MainActor () async throws -> ComposerImagePasteboard.Snapshot
    ) {
        guard canAttachImages else {
            backendClient.presentChatImageError(BackendError.message(ComposerImagePasteboard.PasteError.unsupported.message))
            return
        }
        let capacity = max(0, 8 - attachedImages.count)
        guard capacity > 0 else {
            backendClient.presentChatImageError(BackendError.message(ComposerImagePasteboard.PasteError.full.message))
            return
        }
        guard let session, let token = imageImportState.begin() else {
            backendClient.presentChatImageError(BackendError.message(L10n("图片正在导入，请稍后再试。")))
            return
        }
        let draft = editorController.draft
        imageImportState.task = Task { @MainActor in
            defer { imageImportState.finish(token) }
            do {
                let snapshot = try await load()
                try Task.checkCancellation()
                let batch = await ComposerImagePreparation.shared.prepare(snapshot, capacity: capacity)
                defer { batch.cleanup() }
                var failures = batch.failed
                var firstImportError: String?
                for prepared in batch.images {
                    guard imageImportState.accepts(token), !Task.isCancelled else { return }
                    do {
                        let image = try await backendClient.importChatImage(at: prepared.url, to: session,
                            preserveOriginal: !prepared.temporary)
                        guard imageImportState.accepts(token), !Task.isCancelled,
                              editorController.draft === draft else {
                            await backendClient.removeUnsentChatImage(image, from: session)
                            return
                        }
                        if !attachedImages.contains(image) {
                            attachedImages.append(image)
                            draft.images = attachedImages
                        }
                    } catch is CancellationError { return }
                    catch {
                        failures += 1
                        if firstImportError == nil { firstImportError = error.localizedDescription }
                    }
                }
                guard imageImportState.accepts(token), !Task.isCancelled else { return }
                var messages: [String] = []
                if failures > 0 {
                    messages.append(ComposerImagePasteboard.PasteError.partial(failures).message)
                }
                if let firstImportError { messages.append(firstImportError) }
                if batch.truncated { messages.append(ComposerImagePasteboard.PasteError.truncated.message) }
                if !messages.isEmpty {
                    backendClient.presentChatImageError(BackendError.message(messages.joined(separator: "\n")))
                }
            } catch is CancellationError { return }
            catch {
                if imageImportState.accepts(token) { backendClient.presentChatImageError(error) }
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

    static func resolvedHeight(text: String, measuredHeight: CGFloat) -> CGFloat {
        text.isEmpty ? minimumHeight : resolvedHeight(for: measuredHeight)
    }
}

enum CompactComposerLayout {
    static let maximumWidth: CGFloat = 460
    static let maximumInputHeight: CGFloat = 72
    static let textInsetHeight: CGFloat = 3

    static func resolvedInputHeight(_ measuredHeight: CGFloat) -> CGFloat {
        min(maximumInputHeight, max(ComposerInputLayout.minimumHeight, measuredHeight))
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
