import AppKit
import Combine
import CorptieClientCore
import CorptieConversation
import Observation
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

/// Existing windows keep their legacy observation boundary. Retained pages
/// instantiate the scoped surface directly, without these global publishers.
struct MessageComposer: View {
    @EnvironmentObject private var backendClient: BackendClient
    let sessionId: String
    let draftRepository: ComposerDraftRepository
    let modelCatalog: ProviderCatalogStore
    var allowsModelSwitch = true
    var compact = false
    let status: TaskStatus?
    let isReady: Bool
    let notReadyReason: SessionNotReadyReason?
    let activityStatus: String?
    var onSubmissionStarted: () -> Void = {}
    var onJumpToLatest: (() -> Void)? = nil
    var hasUnreadMessagesBelow = false
    var quickMessagePresentation: ComposerQuickMessagePresentation? = nil
    @State private var revision: UInt64 = 0
    @State private var mentionCatalogRevision: UInt64 = 0
    var body: some View {
        SessionMessageComposerSurface(sessionId: sessionId, draftRepository: draftRepository,
            modelCatalog: modelCatalog, backendClient: backendClient,
            allowsModelSwitch: allowsModelSwitch, compact: compact, status: status,
            isReady: isReady, notReadyReason: notReadyReason, activityStatus: activityStatus,
            onSubmissionStarted: onSubmissionStarted, onJumpToLatest: onJumpToLatest,
            hasUnreadMessagesBelow: hasUnreadMessagesBelow, quickMessagePresentation: quickMessagePresentation, legacyRevision: revision,
            legacyMentionCatalogRevision: mentionCatalogRevision)
        .onReceive(Publishers.MergeMany([
            backendClient.objectWillChange.map { false }.eraseToAnyPublisher(),
            backendClient.appState.objectWillChange.map { true }.eraseToAnyPublisher(),
            backendClient.archivedSessionController.$sessions.dropFirst().map { _ in false }.eraseToAnyPublisher(),
            LegacyComposerInvalidation.commandUpdates(backendClient.sessionCommandController)
        ])) { metadataChanged in
            revision &+= 1
            if metadataChanged { mentionCatalogRevision &+= 1 }
        }
    }
}

/// Only the legacy shell needs this signal. Model switching is observed inside
/// CodexModelMenu; Git/schedule/other command changes do not concern the editor.
@MainActor enum LegacyComposerInvalidation {
    static func commandUpdates(_ commands: SessionCommandController) -> AnyPublisher<Bool, Never> {
        commands.$isSendingMessage.removeDuplicates().dropFirst().map { _ in false }.eraseToAnyPublisher()
    }
}

struct SessionMessageComposerSurface: View {
    private let modelCatalog: ProviderCatalogStore
    private let backendClient: BackendClient
    let renderInputs: SessionPageRenderInputs?
    let legacyRevision: UInt64
    let legacyMentionCatalogRevision: UInt64
    private var acceptsPresentationUpdates: Bool { renderInputs?.acceptsPresentationUpdates ?? true }
    private var allowsActions: Bool {
        guard let renderInputs else { return true }
        return renderInputs.actionSession(generation: renderInputs.activity.generation) != nil
    }
    private var online: Bool { renderInputs?.online ?? backendClient.isOnline }
    private var sendingMessage: Bool { renderInputs?.sendingMessage ?? backendClient.isSendingMessage }
    let sessionId: String
    let draftRepository: ComposerDraftRepository
    let allowsModelSwitch: Bool
    let compact: Bool
    let status: TaskStatus?
    let isReady: Bool
    let notReadyReason: SessionNotReadyReason?
    let activityStatus: String?
    let onSubmissionStarted: () -> Void
    let onJumpToLatest: (() -> Void)?
    let hasUnreadMessagesBelow: Bool
    @State private var editorController: ComposerEditorController
    @State private var hasSendableText: Bool
    @State private var isShowingScheduleSheet = false
    @State private var scheduleSubmission: ComposerDraftBuffer.Submission?
    @State private var attachedImages: [ChatImageReference] = []
    @State private var imageImportState = ComposerImageImportState()
    private var isImportingImages: Bool { imageImportState.busy }
    @State private var isShowingPhotoPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var selectedMentions: [ConversationMention] = []
    @State private var quickMessageRefresh = 0
    @State private var localQuickMessagePresentation = ComposerQuickMessagePresentation()
    let quickMessagePresentation: ComposerQuickMessagePresentation?
    private var showsQuickMessages: Bool {
        get { (quickMessagePresentation ?? localQuickMessagePresentation).showsMessages }
        nonmutating set {
            (quickMessagePresentation ?? localQuickMessagePresentation).showsMessages = newValue
        }
    }

    init(
        sessionId: String,
        draftRepository: ComposerDraftRepository,
        modelCatalog: ProviderCatalogStore,
        backendClient: BackendClient,
        allowsModelSwitch: Bool = true,
        compact: Bool = false,
        status: TaskStatus?,
        isReady: Bool,
        notReadyReason: SessionNotReadyReason?,
        activityStatus: String?,
        onSubmissionStarted: @escaping () -> Void = {},
        onJumpToLatest: (() -> Void)? = nil, hasUnreadMessagesBelow: Bool = false,
        quickMessagePresentation: ComposerQuickMessagePresentation? = nil,
        renderInputs: SessionPageRenderInputs? = nil, legacyRevision: UInt64 = 0,
        legacyMentionCatalogRevision: UInt64 = 0
    ) {
        self.quickMessagePresentation = quickMessagePresentation
        self.sessionId = sessionId
        self.modelCatalog = modelCatalog
        self.backendClient = backendClient
        self.renderInputs = renderInputs; self.legacyRevision = legacyRevision
        self.legacyMentionCatalogRevision = legacyMentionCatalogRevision
        self.draftRepository = draftRepository
        self.allowsModelSwitch = allowsModelSwitch
        self.compact = compact
        self.status = status
        self.isReady = isReady
        self.notReadyReason = notReadyReason
        self.activityStatus = activityStatus
        self.onSubmissionStarted = onSubmissionStarted
        self.onJumpToLatest = onJumpToLatest
        self.hasUnreadMessagesBelow = hasUnreadMessagesBelow
        let draft = draftRepository.draft(for: sessionId)
        draft.sessionId = sessionId
        _attachedImages = State(initialValue: draft.images)
        _selectedMentions = State(initialValue: draft.mentions)
        _editorController = State(initialValue: renderInputs?.editorController(for: draftRepository) ?? ComposerEditorController(draft: draft))
        _hasSendableText = State(initialValue: draft.hasSendableText)
    }

    var body: some View {
        let _ = legacyRevision
        let _ = SessionSwitchTrace.shared.mark(.composerBody, sessionID: sessionId)
        return composerLayout
            .onChange(of: renderInputs?.activity.isActive) { _, _ in synchronizePresentation() }
    }

    private var composerLayout: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !compact && quickMessagePresentation == nil && (showsQuickMessages || onJumpToLatest != nil) {
                ComposerQuickMessagesBar(backendClient: backendClient, sessionId: sessionId,
                    taskID: session?.taskId, online: online,
                    refreshRevision: renderInputs?.quickMessageRevision ?? quickMessageRefresh,
                    enabled: canSend && !sendingMessage && session?.archived != true,
                    activity: renderInputs?.activity, showsMessages: showsQuickMessages,
                    onJumpToLatest: onJumpToLatest, hasUnreadMessagesBelow: hasUnreadMessagesBelow) { text in
                    guard canSend, !sendingMessage, let session, session.archived != true else { return }
                    if backendClient.sendMessage(text, to: session, onSuccess: didSendMessage) { onSubmissionStarted() }
                }
            }
            if compact {
                compactEditorRow
                    .frame(maxWidth: CompactComposerLayout.maximumWidth)
            } else {
                ConversationComposerChrome(verticalPadding: 10, contentSpacing: 8, headerAtBottom: true) {
                    composerToolbar
                } content: {
                    editorRow
                }
                .frame(maxWidth: .infinity)
            }
            if isImportingImages {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L10n("正在添加图片…")).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = imageImportState.errorMessage {
                HStack(alignment: .top, spacing: 8) {
                    Text(error).font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    Button { imageImportState.dismissError() } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .help(L10n("关闭图片导入提示"))
                    .accessibilityLabel(L10n("关闭图片导入提示"))
                }
                .accessibilityIdentifier("composer-image-import-error")
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .onReceive(NotificationCenter.default.publisher(for: .consoleComposerFocusRequested).whilePresented(acceptsPresentationUpdates)) { notification in
            if acceptsPresentationUpdates, notification.object as? String == sessionId { editorController.focusIfRequested() }
        }
        .onChange(of: attachedImages) { _, images in
            if acceptsPresentationUpdates { editorController.draft.images = images }
        }
        .onAppear { synchronizePresentation() }
        .onDisappear { imageImportState.invalidate() }
        .photosPicker(
            isPresented: $isShowingPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: max(1, 8 - attachedImages.count),
            matching: .images,
            preferredItemEncoding: .current
        )
        .onChange(of: selectedPhotoItems) { _, items in importPhotoItems(items) }
        .onChange(of: selectedMentions) { _, mentions in
            if acceptsPresentationUpdates { editorController.draft.mentions = mentions }
        }
        .task(id: renderInputs?.activity.isActive) {
            guard acceptsPresentationUpdates, allowsActions, allowsModelSwitch,
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

    private func synchronizePresentation() {
        if acceptsPresentationUpdates {
            attachedImages = editorController.draft.images
            selectedMentions = editorController.draft.mentions
            hasSendableText = editorController.draft.hasSendableText
            imageImportState.activate()
        } else {
            imageImportState.invalidate()
            isShowingPhotoPicker = false
            isShowingScheduleSheet = false
        }
    }

    private func didSendMessage() {
        if let renderInputs { renderInputs.didSendMessage() }
        else { quickMessageRefresh &+= 1; quickMessagePresentation?.refreshRevision &+= 1 }
    }

    private func stopButton(compact: Bool) -> some View {
        SessionComposerStopSurface(session: session, online: online, compact: compact) {
            guard allowsActions else { return }
            let target = renderInputs?.actionSession(generation: renderInputs?.activity.generation ?? 0) ?? session
            guard let target, target.executionTaskStatus == .running, target.canInterruptNow else { return }
            backendClient.interrupt(session: target, surface: .sessionDetailComposerControl)
        }
    }

    private var editorRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !attachedImages.isEmpty {
                ComposerAttachmentsSurface(images: attachedImages, sessionId: sessionId,
                    backendClient: backendClient, onRemove: removeAttachedImage)
            }
            ComposerEditorSurface(sessionId: sessionId, editorController: editorController,
                backendClient: backendClient, renderInputs: renderInputs,
                legacyMentionCatalogRevision: legacyMentionCatalogRevision, compact: compact,
                hasSendableText: $hasSendableText, selectedMentions: $selectedMentions,
                onPasteImages: importImagesFromPasteboard, onSubmit: send)
                .frame(minWidth: 0, maxWidth: .infinity)
                .padding(.horizontal, 10)
        }
        .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: nil) { providers in
            importDroppedImages(providers)
        }
    }

    private var composerToolbar: some View {
        ComposerEditorRowLayout(minimumEditorWidth: 100, preservesLeadingContentWidth: true) {
            HStack(spacing: 6) {
                moreMenu
                ComposerStatusSurface(sessionID: sessionId, status: status, isReady: isReady,
                    notReadyReason: notReadyReason, activityStatus: activityStatus, renderInputs: renderInputs)
                Spacer(minLength: 0)
            }
            ComposerActionSurface(showsModel: allowsModelSwitch && canSwitchModel,
                                  showsStop: showsStopControl) {
                ComposerModelSelectionSurface(modelCatalog: modelCatalog, backendClient: backendClient,
                    renderInputs: renderInputs, maximumWidth: modelMenuMaxWidth, session: session)
            } stop: {
                stopButton(compact: false)
            } send: {
                sendButton
            }
        }
    }

    private var showsStopControl: Bool {
        session?.executionTaskStatus == .running && session?.canInterruptNow == true
    }

    private var compactEditorRow: some View {
        VStack(spacing: 0) {
            if !attachedImages.isEmpty {
                ComposerAttachmentsSurface(images: attachedImages, sessionId: sessionId,
                    backendClient: backendClient, onRemove: removeAttachedImage)
            }
            HStack(spacing: 2) {
                ComposerEditorSurface(sessionId: sessionId, editorController: editorController,
                backendClient: backendClient, renderInputs: renderInputs,
                legacyMentionCatalogRevision: legacyMentionCatalogRevision, compact: compact,
                hasSendableText: $hasSendableText, selectedMentions: $selectedMentions,
                onPasteImages: importImagesFromPasteboard, onSubmit: send)
                    .frame(minWidth: 0, maxWidth: .infinity)
                    .padding(.leading, 8)
                    .padding(.trailing, 2)
                    .layoutPriority(-1)
                sendButton
                if session?.executionTaskStatus == .running,
                   session?.canInterruptNow == true {
                    stopButton(compact: true)
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

    private var sendButton: some View {
        Button { sendCurrentDraft() } label: {
            Group {
                if sendingMessage || isImportingImages {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .semibold))
                }
            }
            .foregroundStyle(isSendDisabled ? Color.secondary : Color.white)
            .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
            .background(isSendDisabled ? Color.primary.opacity(0.06) : Color.accentColor, in: Circle())
                .contentShape(Circle().inset(by: compact ? 0 : -8))
        }
        .buttonStyle(.plain)
        .disabled(isSendDisabled)
        .help(isImportingImages ? L10n("正在导入图片…") : L10n("Send instruction"))
        .accessibilityLabel(isImportingImages ? L10n("正在导入图片…") : L10n("Send instruction"))
        .accessibilityIdentifier("conversation-composer-send")
    }

    private var moreMenu: some View {
        @Bindable var quickMessages = quickMessagePresentation ?? localQuickMessagePresentation
        return Menu {
            if !compact {
                Toggle(L10n("显示快捷指令"), isOn: $quickMessages.showsMessages)
                Divider()
            }
            Button {
                guard allowsActions else { return }
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
                guard allowsActions else { return }
                scheduleSubmission = editorController.submission()
                isShowingScheduleSheet = true
            } label: {
                Label(L10n("创建定时消息"), systemImage: ScheduledSessionAccessibilityID.composerSymbol)
            }
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.composerEntry)
        } label: {
            ComposerActionGlyph(systemName: "plus", tint: ComposerPalette.secondaryText,
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

    private func sendCurrentDraft() {
        guard allowsActions else { return }
        guard let submission = editorController.submission(allowingImageOnly: true) else { return }
        send(submission)
    }

    private func clearScheduledSubmissionIfUnchanged() {
        guard allowsActions, let scheduleSubmission else { return }
        if editorController.clear(ifUnchangedSince: scheduleSubmission) {
            hasSendableText = false
        }
        self.scheduleSubmission = nil
    }

    private func send(_ submission: ComposerDraftBuffer.Submission) {
        guard let session,
              canSend,
              !isImportingImages,
              !sendingMessage else {
            return
        }
        let submittedImages = attachedImages
        let submittedMentions = selectedMentions.filter { submission.text.contains("@\($0.displayName)") }
        let didStartSending = backendClient.sendMessage(submission.text, to: session,
            images: submittedImages,
            mentions: submittedMentions,
            onSuccess: didSendMessage,
            onFailure: {
            guard renderInputs?.acceptsScopeResults ?? true,
                  editorController.draft.images.isEmpty, editorController.draft.mentions.isEmpty,
                  editorController.restoreAfterFailedSubmission(submission) else { return }
            editorController.draft.images = submittedImages
            editorController.draft.mentions = submittedMentions
            if acceptsPresentationUpdates {
                hasSendableText = editorController.draft.hasSendableText
                attachedImages = submittedImages
                selectedMentions = submittedMentions
            }
        })
        guard didStartSending else {
            return
        }
        onSubmissionStarted()
        if editorController.clear(ifUnchangedSince: submission) {
            hasSendableText = false
        }
        editorController.draft.images = []
        editorController.draft.mentions = []
        attachedImages = []
        selectedMentions = []
    }

    private var isSendDisabled: Bool {
        return (!hasSendableText && attachedImages.isEmpty)
            || isImportingImages
            || sendingMessage
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
        guard allowsActions else { return }
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
        guard allowsActions else { return }
        guard canAttachImages else {
            imageImportState.showError(ComposerImagePasteboard.PasteError.unsupported.message)
            return
        }
        let capacity = max(0, 8 - attachedImages.count)
        guard capacity > 0 else {
            imageImportState.showError(ComposerImagePasteboard.PasteError.full.message)
            return
        }
        guard let session, let token = imageImportState.begin() else {
            imageImportState.showError(L10n("图片正在导入，请稍后再试。"))
            return
        }
        let draft = editorController.draft
        let generation = renderInputs?.activity.generation
        let acceptsImport = {
            guard acceptsPresentationUpdates else { return false }
            guard let generation, let renderInputs else { return true }
            return renderInputs.actionSession(generation: generation) != nil
        }
        imageImportState.task = Task { @MainActor in
            defer { imageImportState.finish(token) }
            do {
                let snapshot = try await load()
                try Task.checkCancellation()
                guard acceptsImport() else { return }
                let batch = await ComposerImagePreparation.shared.prepare(snapshot, capacity: capacity)
                defer { batch.cleanup() }
                var failures = batch.failed
                var firstImportError: String?
                for prepared in batch.images {
                    guard acceptsImport(), imageImportState.accepts(token), !Task.isCancelled else { return }
                    do {
                        let image = try await backendClient.importChatImage(at: prepared.url, to: session,
                            preserveOriginal: !prepared.temporary)
                        guard acceptsImport(), imageImportState.accepts(token), !Task.isCancelled,
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
                guard acceptsImport(), imageImportState.accepts(token), !Task.isCancelled else { return }
                var messages: [String] = []
                if failures > 0 {
                    messages.append(ComposerImagePasteboard.PasteError.partial(failures).message)
                }
                if let firstImportError { messages.append(firstImportError) }
                if batch.truncated { messages.append(ComposerImagePasteboard.PasteError.truncated.message) }
                if !messages.isEmpty {
                    imageImportState.showError(messages.joined(separator: "\n"), token: token)
                }
            } catch is CancellationError { return }
            catch {
                imageImportState.showError(error.localizedDescription, token: token)
            }
        }
    }

    private func removeAttachedImage(_ image: ChatImageReference) {
        guard allowsActions else { return }
        attachedImages.removeAll { $0.id == image.id }
        editorController.draft.images = attachedImages
        guard let session else { return }
        Task { await backendClient.removeUnsentChatImage(image, from: session) }
    }

    private var session: TaskSession? {
        if let renderInputs { return renderInputs.session }
        return backendClient.sessions.first(where: { $0.id == sessionId })
            ?? backendClient.archivedSessions.first(where: { $0.id == sessionId })
    }

    private var canSend: Bool {
        ComposerSendPolicy.canSend(session: session, sessionId: sessionId,
            backendClient: backendClient, renderInputs: renderInputs)
    }

    private var modelMenuMaxWidth: CGFloat {
        176
    }
}

/// Observe only the derived menu budget, not every pixel of the composer.
/// Eight-point budgets preserve readable truncation without feeding continuous
/// window geometry back into the whole SwiftUI input surface.
enum ComposerModelWidthPolicy {
    static func maximumWidth(for composerWidth: CGFloat) -> CGFloat {
        guard composerWidth.isFinite, composerWidth > 0 else { return 176 }
        let available = min(ComposerShellMetrics.modelMenuMaxWidth(composerWidth: composerWidth, presentation: .regular),
            max(80, composerWidth - 124))
        return floor(available / 8) * 8
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


@MainActor
enum ComposerSendPolicy {
    static func canSend(session: TaskSession?, sessionId: String, backendClient: BackendClient,
                        renderInputs: SessionPageRenderInputs?) -> Bool {
        let online = renderInputs?.online ?? backendClient.isOnline
        if let renderInputs, renderInputs.actionSession(generation: renderInputs.activity.generation) == nil { return false }
        guard online, let session, session.isReady else { return false }
        if let renderInputs {
            guard !renderInputs.verifyingBinding, renderInputs.historicalThreadID == nil else { return false }
        } else {
            guard !backendClient.bindingVerificationSessionIDs.contains(sessionId),
                  backendClient.selectedSession?.id != sessionId || backendClient.viewingHistoricalThreadId == nil else { return false }
        }
        return session.actions?.send.available ?? true
    }
}

struct ComposerQuickMessagesBar: View {
    /// Kept in sync with `SessionConversationContent.quickMessageOverlap` so the
    /// floating control never pushes the quick-message strip out of the
    /// transcript's overlap region.
    static let jumpControlSize: CGFloat = 30

    let backendClient: BackendClient
    let sessionId: String
    let taskID: String?
    let online: Bool
    let refreshRevision: Int
    let enabled: Bool
    let activity: ConversationDetailPresentationActivity?
    let showsMessages: Bool
    let onJumpToLatest: (() -> Void)?
    let hasUnreadMessagesBelow: Bool
    let send: (String) -> Void

    var body: some View {
        // The round glass control sits directly above the chips, centred over
        // the reading lane. spacing 0 keeps its lower edge touching the strip;
        // the strip itself lives in the region that overlaps the transcript, so
        // the glass floats above message text instead of on an opaque dock.
        VStack(spacing: 0) {
            if let onJumpToLatest {
                Button(action: onJumpToLatest) {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: Self.jumpControlSize, height: Self.jumpControlSize)
                }
                .buttonStyle(JumpToLatestButtonStyle(highlightsUnread: hasUnreadMessagesBelow))
                .help(L10n("Jump to latest message"))
                .accessibilityLabel(L10n("Jump to latest message"))
                .accessibilityIdentifier("conversation-jump-to-latest")
                .frame(maxWidth: .infinity, alignment: .center)
            }
            HStack(spacing: 8) {
                if showsMessages {
                    MacComposerQuickMessages(host: backendClient.baseURL.absoluteString, sessionID: sessionId,
                        taskID: taskID, online: online, refreshRevision: refreshRevision,
                        enabled: enabled,
                        activity: activity,
                        load: { try await backendClient.quickMessages(for: sessionId) }) { text in
                        send(text)
                    }
                } else {
                    Spacer(minLength: 0)
                }
            }
        }
    }
}

/// Shared only by the editor and its floating actions; no geometry or transcript state.
@MainActor @Observable
final class ComposerQuickMessagePresentation {
    var showsMessages = true
    var refreshRevision = 0
}
