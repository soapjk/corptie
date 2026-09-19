import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
import CorptieClientCore

struct PadComposerExtras: View {
    @Bindable var workspace: PadWorkspace
    let sessionID: String
    let disabled: Bool
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var importing = false
    @State private var mentionSearch = ""
    @State private var showMentions = false
    private var acceptsImages: Bool { workspace.capabilities?.sendImages == true && !disabled && !importing }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let images = workspace.draftImages[sessionID], !images.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(images) { image in
                            HStack(spacing: 4) {
                                PadAttachmentThumbnail(image: image)
                                Button("移除 \(image.fileName)", systemImage: "xmark.circle.fill") {
                                    workspace.draftImages[sessionID]?.removeAll { $0.id == image.id }
                                }.labelStyle(.iconOnly).frame(width: 44, height: 44).disabled(disabled)
                            }
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                Menu {
                    Button("选择照片", systemImage: "photo.on.rectangle") { showPhotos = true }
                    Button("选择图片文件", systemImage: "folder") { showFiles = true }
                    Button("粘贴图片", systemImage: "doc.on.clipboard") { pasteImage() }
                } label: { Image(systemName: "plus.circle").frame(width: 44, height: 44) }
                    .accessibilityLabel("添加图片").disabled(!acceptsImages)
                Button("引用 Work 或会话", systemImage: "at") { showMentions = true }
                    .labelStyle(.iconOnly).frame(width: 44, height: 44)
                    .disabled(disabled || workspace.capabilities?.sendMentions != true)
                if importing { ProgressView().controlSize(.small) }
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 8, matching: .images)
        .task(id: photos) {
            guard !photos.isEmpty else { return }
            importing = true
            workspace.importingImagesForSession = sessionID
            defer {
                importing = false; photos = []
                if workspace.importingImagesForSession == sessionID { workspace.importingImagesForSession = nil }
            }
            for photo in photos {
                do {
                    if let data = try await photo.loadTransferable(type: Data.self) {
                        guard !Task.isCancelled else { return }
                        add(data, name: "照片.\(photo.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg")")
                    }
                } catch { workspace.conversationNotice = "照片导入失败，请重试。" }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            do {
                for url in try result.get() {
                    let accessed = url.startAccessingSecurityScopedResource()
                    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size > 0, size <= 20 * 1024 * 1024 else {
                        workspace.conversationNotice = "图片总大小不能超过 20 MB。"; continue
                    }
                    add(try Data(contentsOf: url, options: .mappedIfSafe), name: url.lastPathComponent)
                }
            } catch { workspace.conversationNotice = "图片文件读取失败。" }
        }
        .dropDestination(for: Data.self) { data, _ in
            guard acceptsImages else { return false }
            for item in data { add(item, name: "拖入的图片") }
            return true
        }
        .popover(isPresented: $showMentions) {
            NavigationStack {
                List {
                    ForEach(workspace.works.filter { mentionSearch.isEmpty || $0.name.localizedCaseInsensitiveContains(mentionSearch) }) { work in
                        Button(work.name, systemImage: "briefcase") { mention(type: "work", id: work.id, name: work.name) }
                    }
                    ForEach(workspace.sessions.filter { $0.id != sessionID && (mentionSearch.isEmpty || $0.title.localizedCaseInsensitiveContains(mentionSearch)) }) { session in
                        Button(session.title, systemImage: "bubble.left.and.bubble.right") {
                            mention(type: "session", id: session.id, name: session.title)
                        }
                    }
                }.searchable(text: $mentionSearch).navigationTitle("引用")
            }.frame(minWidth: 300, minHeight: 360)
        }
    }

    private func mention(type: String, id: String, name: String) {
        let item = ClientDraftMention(targetType: type, targetId: id, displayName: name)
        var selected = workspace.draftMentions[sessionID] ?? []
        if !selected.contains(where: { $0.id == item.id }) {
            guard selected.count < 8 else { workspace.conversationNotice = "最多引用 8 个 Work 或会话。"; return }
            selected.append(item)
        }
        workspace.draftMentions[sessionID] = selected
        workspace.drafts[sessionID, default: ""] += "@\(name) "
        showMentions = false
    }
    private func pasteImage() {
        for type in [UTType.png, .jpeg, .heic, .gif, .webP] {
            if let data = UIPasteboard.general.data(forPasteboardType: type.identifier) {
                add(data, name: "粘贴的图片.\(type.preferredFilenameExtension ?? "png")")
                return
            }
        }
        workspace.conversationNotice = "剪贴板中没有支持的图片。"
    }
    private func add(_ data: Data, name: String) {
        guard workspace.pending == nil else { return }
        let images = workspace.draftImages[sessionID] ?? []
        guard images.count < 8, !data.isEmpty,
              images.reduce(data.count, { $0 + $1.data.count }) <= 20 * 1024 * 1024 else {
            workspace.conversationNotice = "最多添加 8 张图片，总大小不能超过 20 MB。"; return
        }
        guard CGImageSourceCreateWithData(data as CFData, nil) != nil else {
            workspace.conversationNotice = "无法识别这个图片文件。"; return
        }
        workspace.draftImages[sessionID, default: []].append(ClientDraftImage(fileName: name, data: data))
    }
}

private struct PadAttachmentThumbnail: View {
    let image: ClientDraftImage
    @State private var thumbnail: UIImage?
    var body: some View {
        Group {
            if let thumbnail { Image(uiImage: thumbnail).resizable().scaledToFit() }
            else { Image(systemName: "photo") }
        }
        .frame(width: 64, height: 64).accessibilityLabel(image.fileName)
        .task(id: image.id) {
            // Decode a small thumbnail, never the full-resolution source into the view tree.
            let data = image.data
            let result = await Task.detached(priority: .utility) { () -> CGImage? in
                guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
                return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 160,
                    kCGImageSourceCreateThumbnailWithTransform: true
                ] as CFDictionary)
            }.value
            if let result, !Task.isCancelled { thumbnail = UIImage(cgImage: result) }
        }
    }
}

struct PadScheduleMessageView: View {
    @Environment(\.dismiss) private var dismiss
    let connection: PadConnection
    let workspace: PadWorkspace
    let sessionID: String
    @State private var runAt = Date().addingTimeInterval(3600)
    @State private var expiresAt = Date().addingTimeInterval(86400 * 7)
    @State private var interval = 0
    @State private var submitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("消息") { Text(workspace.drafts[sessionID] ?? "").lineLimit(8) }
                Section("触发时间") {
                    DatePicker("首次发送", selection: $runAt, in: Date()...)
                    Picker("重复", selection: $interval) {
                        Text("不重复").tag(0)
                        Text("每小时").tag(3600)
                        Text("每天").tag(86400)
                        Text("每周").tag(604800)
                    }
                    DatePicker("到期时间", selection: $expiresAt, in: runAt...)
                    Text("由 Mac 后端执行。Mac 需要在线；撤销本设备授权后不再发送。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !workspace.conversationNotice.isEmpty { Text(workspace.conversationNotice) }
            }
            .navigationTitle("定时消息").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(submitting) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") {
                        submitting = true
                        Task {
                            await workspace.command(connection, stop: false, schedule: ClientMessageSchedule(
                                runAt: runAt, expiresAt: expiresAt, intervalSeconds: interval == 0 ? nil : interval))
                            submitting = false
                            if workspace.pending != nil || (workspace.drafts[sessionID] ?? "").isEmpty { dismiss() }
                        }
                    }.disabled(submitting || connection.busy || workspace.selection != sessionID
                        || runAt <= Date() || expiresAt <= runAt)
                }
            }
            .interactiveDismissDisabled(submitting)
        }
    }
}
