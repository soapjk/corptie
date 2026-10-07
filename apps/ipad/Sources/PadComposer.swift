import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
import UIKit
import CorptieClientCore
import CorptieConversation

/// The desktop `MessageComposer` row on iPad: attachment strip, editor, optional
/// send glyph and more glyph inside one shell, model menu beside it. Draft text / images /
/// mentions live in the workspace so a submission snapshot can clear them safely.
struct PadComposer<Header: View>: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let sessionID: String
    let scheduleMessage: () -> Void
    let canStop: Bool
    let stop: () -> Void
    @ViewBuilder let header: () -> Header
    @State private var editor = PadComposerEditor()
    @State private var inputHeight = ComposerShellMetrics.minimumInputHeight
    @State private var composerWidth: CGFloat = 0
    @State private var mentionQuery: ComposerMentionQuery?
    @State private var mentionSelectionIndex = 0
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var importing = false
    @State private var isKeyboardVisible = false
    @State private var quickMessages = ClientQuickMessage.defaults
    @State private var quickMessageRefresh = 0
    @State private var quickMessageScope = ""
    @State private var confirmStopRetries = false

    private var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    private var quickMessageTaskID: String? { workspace.sessionsByID[sessionID]?.taskId }
    private var phoneBottomOffset: CGFloat {
        guard isPhone, !isKeyboardVisible else { return 0 }
        let bottomInset = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?.safeAreaInsets.bottom
            ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first?.safeAreaInsets.bottom
            ?? 34
        return bottomInset > 0 ? 10 : 0
    }

    private var draft: Binding<String> {
        Binding(get: { workspace.drafts[sessionID] ?? "" }, set: { workspace.drafts[sessionID] = $0 })
    }
    private var attachedImages: [ClientDraftImage] { workspace.draftImages[sessionID] ?? [] }
    private var isSubmitting: Bool {
        workspace.pending.map { $0.draftSessionID == sessionID && $0.kind != "stop" } ?? false
    }
    private var canAttachImages: Bool {
        workspace.capabilities?.sendImages == true && !importing && attachedImages.count < ComposerShellMetrics.maximumAttachments
    }
    private var isSendDisabled: Bool {
        let text = draft.wrappedValue
        return connection.busy || workspace.pending != nil || isSubmitting || workspace.outboxSaving
            || workspace.capabilities?.send.available != true
            || workspace.importingImagesForSession == sessionID
            || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachedImages.isEmpty)
            || text.utf16.count > 16000
    }
    private var canScheduleMessage: Bool {
        workspace.capabilities?.scheduleMessage == true && workspace.pending == nil
            && !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && attachedImages.isEmpty && (workspace.draftMentions[sessionID] ?? []).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if workspace.deliveryIssues[sessionID] != nil {
                HStack {
                    Text("有消息仍未送达，原内容已保留")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("停止重试") { confirmStopRetries = true }
                        .font(.caption)
                }
                .padding(.horizontal, 8)
            }
            ConversationQuickMessages(items: quickMessages,
                enabled: !connection.busy && workspace.pending == nil && !workspace.outboxSaving
                    && workspace.capabilities?.send.available == true
                    && workspace.importingImagesForSession != sessionID) { text in
                Task {
                    await workspace.sendSuggestedReply(connection, sessionID: sessionID, text: text)
                    quickMessageRefresh += 1
                }
            }
        ConversationComposerChrome(verticalPadding: isPhone ? 3 : 6,
                                   contentSpacing: isPhone ? 1 : 2) {
            if isPhone {
                HStack(spacing: 4) {
                    header()
                        .frame(minWidth: 0, maxWidth: .infinity)
                    if workspace.capabilities?.composer == true {
                        PadModelMenu(connection: connection, workspace: workspace, maxWidth: 54)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
            } else {
                header()
            }
        } content: {
            editorRow
        }
        }
        .task(id: "\(sessionID):\(quickMessageTaskID ?? ""):\(connection.serverID):\(quickMessageRefresh)") {
            let taskID = quickMessageTaskID
            let scope = ClientQuickMessageCache.scope(host: connection.serverID,
                taskID: taskID, sessionID: sessionID)
            if quickMessageScope != scope {
                quickMessages = ClientQuickMessageCache.shared.items(for: scope)
                quickMessageScope = scope
            }
            do {
                let api = ClientSessionAPI(transport: try await connection.transport())
                let result = try await api.quickMessages(sessionId: workspace.capabilities?.sessionId ?? sessionID)
                guard !Task.isCancelled, quickMessageScope == scope,
                      taskID == nil || result.taskId == taskID else { return }
                let resolvedScope = ClientQuickMessageCache.scope(host: connection.serverID,
                    taskID: result.taskId, sessionID: sessionID)
                let items = ClientQuickMessageCache.shared.remember(result.items, for: resolvedScope)
                if resolvedScope != scope { ClientQuickMessageCache.shared.remember(items, for: scope) }
                if quickMessages != items { quickMessages = items }
            } catch {
                // Read-only recommendation failure must not block the composer.
            }
        }
        .offset(y: phoneBottomOffset)
        .confirmationDialog("停止后续重试？", isPresented: $confirmStopRetries, titleVisibility: .visible) {
            Button("停止重试", role: .destructive) {
                Task { await workspace.stopReliableRetries(connection, displaySessionID: sessionID) }
            }
            Button("继续自动发送", role: .cancel) {}
        } message: {
            Text("消息内容仍保留在本机。这不会撤回已经到达后端的请求，后端仍可能执行。")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            guard isPhone else { return }
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            guard isPhone else { return }
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = false }
        }
        // Outside the glass and above the entire module, without presenting a
        // controller or stealing first responder from the editor.
        .overlay(alignment: .topLeading) {
            let suggestions = mentionSuggestions
            if mentionQuery != nil, !suggestions.isEmpty {
                GeometryReader { proxy in
                    let layout = PadMentionMenuPlacement(moduleTop: proxy.frame(in: .named("conversation-viewport")).minY,
                        moduleWidth: proxy.size.width,
                        preferredHeight: ComposerMentionMenuMetrics.height(candidateCount: suggestions.count))
                    if layout.height > 0 {
                        ComposerMentionMenu(suggestions: suggestions, selectedIndex: mentionSelectionIndex,
                                            onSelect: selectMention)
                            .frame(width: layout.width, height: layout.height)
                            .background(ComposerPalette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Color.black.opacity(0.10), lineWidth: 1))
                            .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
                            .offset(y: layout.offsetY)
                            .accessibilityIdentifier("conversation-composer-mention-menu")
                    }
                }
            }
        }
    }

    private var editorRow: some View {
        ConversationComposerEditorRow(
            showsAttachments: !attachedImages.isEmpty,
            showsModel: !isPhone && workspace.capabilities?.composer == true
        ) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: ComposerShellMetrics.attachmentSpacing) {
                    ForEach(attachedImages) { image in
                        PadDraftImageChip(image: image) {
                            workspace.draftImages[sessionID]?.removeAll { $0.id == image.id }
                        }
                    }
                }
                .padding(.horizontal, 9)
                .padding(.top, 8)
                .padding(.bottom, 4)
            }
            .frame(height: ComposerShellMetrics.attachmentStripHeight)
        } editor: {
            PadComposerTextView(
                text: draft,
                placeholder: "Send a instruction",
                editor: editor,
                onHeightChange: { next in if abs(inputHeight - next) > 0.5 { inputHeight = next } },
                onFocusChange: { _ in },
                onSelectionChange: updateMentionQuery,
                onKey: handleKey,
                onSubmit: submit,
                allowsEmptyTextSubmission: isPhone && !attachedImages.isEmpty,
                onPasteImages: pasteImages
            )
            .frame(height: PadComposerHeightPolicy.height(
                text: draft.wrappedValue, measured: inputHeight, isPhone: isPhone))
        } send: {
            if isPhone {
                if canStop {
                    Button(action: stop) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.red)
                            .frame(width: 20, height: 20)
                            .padGlassSurface(in: Circle(), tint: .red.opacity(0.12))
                            .overlay {
                                Circle().strokeBorder(Color.red.opacity(0.45), lineWidth: 1)
                                    .allowsHitTesting(false)
                            }
                            .frame(width: ComposerShellMetrics.actionHitEdge,
                                   height: ComposerShellMetrics.actionHitEdge)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!workspace.stopControlEnabled(connection))
                    .accessibilityHint(workspace.stopControlReason(connection) ?? "停止当前运行")
                    .accessibilityLabel("停止当前运行")
                    .accessibilityIdentifier("conversation-stop")
                }
            } else {
                Button {
                    submit()
                } label: {
                    ComposerActionGlyph(systemName: "paperplane.fill", tint: ComposerPalette.softBlue,
                                        isBusy: isSubmitting, showsSurface: false)
                        .overlay {
                            Circle().strokeBorder(ComposerPalette.softBlue.opacity(0.4), lineWidth: 1)
                                .allowsHitTesting(false)
                        }
                        .conversationGlassControl(tint: ComposerPalette.softBlue)
                        .contentShape(Circle().inset(by: -8))
                }
                .buttonStyle(.plain)
                .disabled(isSendDisabled)
                .accessibilityLabel("发送")
                .accessibilityIdentifier("conversation-composer-send")
            }
        } more: {
            Menu {
                Button {
                    showPhotos = true
                } label: {
                    Label(importing ? "正在导入图片…" : "从照片选择", systemImage: "photo.on.rectangle")
                }
                .disabled(!canAttachImages)
                Button {
                    showFiles = true
                } label: {
                    Label("从文件选择", systemImage: "folder")
                }
                .disabled(!canAttachImages)
                Button {
                    scheduleMessage()
                } label: {
                    Label("创建定时消息", systemImage: "calendar.badge.clock")
                }
                .disabled(!canScheduleMessage)
            } label: {
                ComposerActionGlyph(systemName: "ellipsis", tint: ComposerPalette.secondaryText,
                                    weight: .semibold, showsSurface: false)
                    .contentShape(Circle().inset(by: -8))
            }
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
            .fixedSize()
            .accessibilityLabel("更多功能")
            .accessibilityIdentifier("composer.more-actions")
        } model: {
            PadModelMenu(connection: connection, workspace: workspace,
                         maxWidth: ComposerShellMetrics.modelMenuMaxWidth(composerWidth: composerWidth))
        }
        .dropDestination(for: Data.self) { items, _ in
            guard canAttachImages else { return false }
            for item in items { addImage(item, name: "拖入的图片") }
            return true
        }
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: PadComposerWidthKey.self, value: proxy.size.width)
            }
        }
        .onPreferenceChange(PadComposerWidthKey.self) { width in
            let rounded = width.rounded(.down)
            if rounded != composerWidth { composerWidth = rounded }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photos,
                      maxSelectionCount: max(1, ComposerShellMetrics.maximumAttachments - attachedImages.count),
                      matching: .images)
        .onChange(of: draft.wrappedValue) { _, text in
            if text.isEmpty { inputHeight = ComposerShellMetrics.minimumInputHeight }
        }
        .task(id: photos) { await importPhotos() }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true, onCompletion: importFiles)
        .task(id: "\(sessionID)|\(workspace.capabilities?.composer == true)") {
            guard workspace.composerConfiguration == nil, workspace.capabilities?.composer == true else { return }
            await workspace.configureComposer(connection)
        }
    }

    // MARK: Mentions

    private var activeMentionIDs: Set<String> {
        let text = draft.wrappedValue
        return Set((workspace.draftMentions[sessionID] ?? []).filter { text.contains("@\($0.displayName)") }.map(\.id))
    }

    private var mentionSuggestions: [ComposerMentionSuggestion] {
        guard let mentionQuery, workspace.capabilities?.sendMentions == true else { return [] }
        return ComposerMentionCatalog.suggestions(
            works: workspace.works.map { .init(id: $0.id, name: $0.name) },
            sessions: workspace.sessions.map { .init(id: $0.id, title: $0.title, workId: $0.workId) },
            currentSessionID: sessionID, activeMentionIDs: activeMentionIDs, query: mentionQuery.text)
    }

    private func updateMentionQuery(_ text: String, _ selection: NSRange) {
        let query = ComposerMentionQuery.resolve(in: text, selection: selection)
        if query?.text != mentionQuery?.text { mentionSelectionIndex = 0 }
        if query != mentionQuery { mentionQuery = query }
    }

    private func submit() {
        mentionQuery = nil
        guard !isSendDisabled else { return }
        Task {
            await workspace.command(connection, stop: false)
            quickMessageRefresh += 1
        }
    }

    private func handleKey(_ key: ComposerKeyPolicy.Key, shift: Bool, hasMarkedText: Bool) -> Bool {
        let suggestions = mentionSuggestions
        let active = mentionQuery != nil && !suggestions.isEmpty
        switch ComposerKeyPolicy.action(for: key, shift: shift, hasMarkedText: hasMarkedText, mentionMenuActive: active) {
        case .passThrough:
            return false
        case .submit:
            submit()
            return true
        case .mentionMove(let delta):
            mentionSelectionIndex = (mentionSelectionIndex + delta + suggestions.count) % suggestions.count
            return true
        case .mentionSelect:
            guard suggestions.indices.contains(mentionSelectionIndex) else { mentionQuery = nil; return true }
            selectMention(suggestions[mentionSelectionIndex])
            return true
        case .mentionDismiss:
            mentionQuery = nil
            return true
        }
    }

    private func selectMention(_ suggestion: ComposerMentionSuggestion) {
        guard let mentionQuery else { return }
        let mention = ClientDraftMention(targetType: suggestion.kind == .work ? "work" : "session",
                                         targetId: suggestion.targetId, displayName: suggestion.displayName)
        var selected = workspace.draftMentions[sessionID] ?? []
        if !selected.contains(where: { $0.id == mention.id }) { selected.append(mention) }
        workspace.draftMentions[sessionID] = selected
        editor.replace(mentionQuery.replacementRange, with: "@\(suggestion.displayName) ")
        self.mentionQuery = nil
        mentionSelectionIndex = 0
        editor.focus()
    }

    // MARK: Images

    private func pasteImages() -> Bool {
        guard canAttachImages else { return false }
        for type in [UTType.png, .jpeg, .heic, .gif, .webP] {
            if let data = UIPasteboard.general.data(forPasteboardType: type.identifier) {
                addImage(data, name: "粘贴的图片.\(type.preferredFilenameExtension ?? "png")")
                return true
            }
        }
        return false
    }

    private func importPhotos() async {
        guard !photos.isEmpty else { return }
        importing = true
        workspace.importingImagesForSession = sessionID
        defer {
            importing = false
            photos = []
            if workspace.importingImagesForSession == sessionID { workspace.importingImagesForSession = nil }
        }
        for photo in photos {
            do {
                if let data = try await photo.loadTransferable(type: Data.self) {
                    guard !Task.isCancelled else { return }
                    addImage(data, name: "照片.\(photo.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg")")
                }
            } catch {
                workspace.conversationNotice = "照片导入失败，请重试。"
            }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        do {
            for url in try result.get() {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0, size <= 20 * 1024 * 1024 else {
                    workspace.conversationNotice = "图片总大小不能超过 20 MB。"
                    continue
                }
                addImage(try Data(contentsOf: url, options: .mappedIfSafe), name: url.lastPathComponent)
            }
        } catch {
            workspace.conversationNotice = "图片文件读取失败。"
        }
    }

    private func addImage(_ data: Data, name: String) {
        guard workspace.pending == nil else { return }
        let images = attachedImages
        guard images.count < ComposerShellMetrics.maximumAttachments, !data.isEmpty,
              images.reduce(data.count, { $0 + $1.data.count }) <= 20 * 1024 * 1024 else {
            workspace.conversationNotice = "最多添加 8 张图片，总大小不能超过 20 MB。"
            return
        }
        guard CGImageSourceCreateWithData(data as CFData, nil) != nil else {
            workspace.conversationNotice = "无法识别这个图片文件。"
            return
        }
        workspace.draftImages[sessionID, default: []].append(ClientDraftImage(fileName: name, data: data))
    }
}

private struct PadComposerWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Model / reasoning menu beside the shell (desktop `CodexModelMenu`), driven by
/// the device composer contract; every switch is a receipt-backed request.
private struct PadModelMenu: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let maxWidth: CGFloat

    private var configuration: ClientComposerConfiguration? { workspace.composerConfiguration }
    private var currentModelID: String { configuration?.currentModel ?? "" }
    private var currentModel: ClientComposerConfiguration.Model? {
        configuration?.models.first { $0.id == currentModelID }
    }
    private var currentModelLabel: String {
        currentModelID.isEmpty ? "Model" : (currentModel?.name ?? currentModelID)
    }
    private var currentReasoningLevel: String {
        configuration?.currentReasoningLevel ?? currentModel?.defaultReasoningLevel ?? "medium"
    }
    private var reasoningLevels: [String] {
        configuration?.switchReasoning.available == true ? (currentModel?.reasoningLevels ?? []) : []
    }

    var body: some View {
        Menu {
            if let configuration {
                ForEach(configuration.models) { model in
                    Button {
                        Task { await workspace.configureComposer(connection, update: ["model": model.id]) }
                    } label: {
                        if model.id == currentModelID { Label(model.name, systemImage: "checkmark") } else { Text(model.name) }
                    }
                    .disabled(!configuration.switchModel.available)
                }
                Divider()
                if configuration.switchReasoning.available {
                    Menu {
                        if reasoningLevels.isEmpty {
                            Text("No reasoning options")
                        } else {
                            ForEach(reasoningLevels, id: \.self) { level in
                                Button {
                                    Task { await workspace.configureComposer(connection, update: ["reasoningLevel": level]) }
                                } label: {
                                    if level == currentReasoningLevel {
                                        Label(ComposerModelLabel.reasoningTitle(level), systemImage: "checkmark")
                                    } else {
                                        Text(ComposerModelLabel.reasoningTitle(level))
                                    }
                                }
                            }
                        }
                    } label: {
                        Label("Reasoning: \(ComposerModelLabel.reasoningTitle(currentReasoningLevel))", systemImage: "brain")
                    }
                    .disabled(reasoningLevels.isEmpty || workspace.configuringComposer)
                }
            }
            Button {
                Task { await workspace.configureComposer(connection) }
            } label: {
                Label("Reload models", systemImage: "arrow.clockwise")
            }
        } label: {
            ComposerModelMenuLabel(
                modelLabel: currentModelLabel,
                reasoningShortLabel: configuration == nil
                    ? ""
                    : ComposerModelLabel.reasoningShort(currentReasoningLevel),
                isBusy: workspace.configuringComposer,
                maxWidth: maxWidth,
                showsSurface: false
            )
        }
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .disabled(configuration != nil && !ComposerModelLabel.menuEnabled(
            canSwitchModel: configuration?.switchModel.available == true,
            canSwitchReasoning: configuration?.switchReasoning.available == true,
            isSwitchingModel: workspace.configuringComposer,
            isSwitchingReasoning: workspace.configuringComposer))
        .accessibilityLabel(currentModelLabel)
        .accessibilityIdentifier("conversation-composer-model")
    }
}

/// Draft image chip: a small thumbnail decoded off the main actor, never the full raster.
private struct PadDraftImageChip: View {
    let image: ClientDraftImage
    let onRemove: () -> Void
    @State private var thumbnail: UIImage?
    @State private var failed = false

    var body: some View {
        ComposerAttachmentChip(image: thumbnail.map(Image.init(uiImage:)), isMissing: failed,
                               accessibilityName: image.fileName, onRemove: onRemove)
            .task(id: image.id) {
                let data = image.data
                let result = await Task.detached(priority: .utility) { () -> CGImage? in
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
                    return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceThumbnailMaxPixelSize: 160,
                        kCGImageSourceCreateThumbnailWithTransform: true
                    ] as CFDictionary)
                }.value
                guard !Task.isCancelled else { return }
                if let result { thumbnail = UIImage(cgImage: result) } else { failed = true }
            }
    }
}
