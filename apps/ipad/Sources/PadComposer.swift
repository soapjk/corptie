import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
import CorptieClientCore
import CorptieConversation

/// The desktop `MessageComposer` row on iPad: attachment strip, editor, send and
/// more glyphs inside one shell, model menu beside it. Draft text / images /
/// mentions live in the workspace so a submission snapshot can clear them safely.
struct PadComposer: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let sessionID: String
    let scheduleMessage: () -> Void
    @State private var editor = PadComposerEditor()
    @State private var inputHeight = ComposerShellMetrics.minimumInputHeight
    @State private var composerWidth: CGFloat = 0
    @State private var isFocused = false
    @State private var mentionQuery: ComposerMentionQuery?
    @State private var mentionSelectionIndex = 0
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var importing = false

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
        return connection.busy || workspace.pending != nil || isSubmitting
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
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                if !attachedImages.isEmpty {
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
                }

                HStack(spacing: 2) {
                    PadComposerTextView(
                        text: draft,
                        placeholder: "Send a instruction",
                        editor: editor,
                        onHeightChange: { next in if abs(inputHeight - next) > 0.5 { inputHeight = next } },
                        onFocusChange: { next in if isFocused != next { isFocused = next } },
                        onSelectionChange: updateMentionQuery,
                        onKey: handleKey,
                        onPasteImages: pasteImages
                    )
                    .frame(minWidth: 0, maxWidth: .infinity)
                    .frame(height: inputHeight)
                    .padding(.leading, 10)
                    .padding(.trailing, 2)
                    .layoutPriority(-1)

                    Button {
                        Task { await workspace.command(connection, stop: false) }
                    } label: {
                        ComposerActionGlyph(systemName: "paperplane.fill", tint: ComposerPalette.softBlue,
                                            isBusy: isSubmitting, showsSurface: false)
                            .padGlassSurface(in: Circle(), interactive: true,
                                             fallbackUsesMaterial: false)
                            .contentShape(Circle().inset(by: -8))
                    }
                    .buttonStyle(.plain)
                    .disabled(isSendDisabled)
                    .accessibilityLabel("发送")
                    .accessibilityIdentifier("conversation-composer-send")

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
                            .padGlassSurface(in: Circle(), interactive: true,
                                             fallbackUsesMaterial: false)
                            .contentShape(Circle().inset(by: -8))
                    }
                    .menuIndicator(.hidden)
                    .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
                    .fixedSize()
                    .accessibilityLabel("更多功能")
                    .accessibilityIdentifier("composer.more-actions")
                    .padding(.trailing, 4)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            .modifier(ComposerShellSurface(isFocused: isFocused))
            // Anchored above the editor rather than presented: a UIKit popover would
            // take first responder from the text view and drop the keyboard.
            .overlay(alignment: .topLeading) {
                let suggestions = mentionSuggestions
                if mentionQuery != nil, !suggestions.isEmpty {
                    ComposerMentionMenu(suggestions: suggestions, selectedIndex: mentionSelectionIndex,
                                        onSelect: selectMention)
                        .frame(width: composerWidth > 0 ? min(ComposerMentionMenuMetrics.width, composerWidth) : ComposerMentionMenuMetrics.width,
                               height: ComposerMentionMenuMetrics.height(candidateCount: suggestions.count))
                        .background(ComposerPalette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.black.opacity(0.10), lineWidth: 1))
                        .shadow(color: Color.black.opacity(0.12), radius: 14, y: 6)
                        .alignmentGuide(.top) { $0[.bottom] + 6 }
                        .padding(.leading, 10)
                        .accessibilityIdentifier("conversation-composer-mention-menu")
                }
            }
            .dropDestination(for: Data.self) { items, _ in
                guard canAttachImages else { return false }
                for item in items { addImage(item, name: "拖入的图片") }
                return true
            }

            if workspace.capabilities?.composer == true {
                PadModelMenu(connection: connection, workspace: workspace,
                             maxWidth: ComposerShellMetrics.modelMenuMaxWidth(composerWidth: composerWidth))
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
        .task(id: photos) { await importPhotos() }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true, onCompletion: importFiles)
        .task {
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

    private func handleKey(_ key: ComposerKeyPolicy.Key, shift: Bool, hasMarkedText: Bool) -> Bool {
        let suggestions = mentionSuggestions
        let active = mentionQuery != nil && !suggestions.isEmpty
        switch ComposerKeyPolicy.action(for: key, shift: shift, hasMarkedText: hasMarkedText, mentionMenuActive: active) {
        case .passThrough:
            return false
        case .submit:
            mentionQuery = nil
            guard !isSendDisabled else { return true }
            Task { await workspace.command(connection, stop: false) }
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
            .padGlassSurface(
                in: RoundedRectangle(
                    cornerRadius: ComposerShellMetrics.modelMenuCornerRadius,
                    style: .continuous
                ),
                interactive: true,
                fallbackUsesMaterial: false
            )
        }
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
