import SwiftUI
import CorptieClientCore

/// Fixed immutable version/hash, authorized on every byte-range read. The
/// document renderer never follows a URL supplied by the card or a locator.
struct ConversationNativeArtifactReader: View {
    let title: String
    let artifactID: String
    let version: Int
    let hash: String
    let action: ClientDetailAction
    let cardID: String
    let documentID: String
    let sessionID: String
    let api: ClientDetailAPI
    let openInResources: ((ClientResourceFocus) -> Void)?
    let workID: String?
    @Environment(\.dismiss) private var dismiss
    @State private var readID = UUID().uuidString
    @State private var document: ResourceDocumentChunk?
    @State private var loadedPages = 0
    @State private var offset: Int? = 0
    @State private var loading = false
    @State private var error: String?
    @State private var binary = false
    @State private var visible = true
    @State private var readTask: Task<Void, Never>?
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Spacer(minLength: 0)
                    Button("在资源管理器中打开", systemImage: "arrow.up.right.square") {
                        guard let openInResources else { return }
                        readTask?.cancel(); dismiss()
                        openInResources(.init(id: artifactID, version: version, hash: hash, workId: workID))
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonStyle(.bordered)
                    .disabled(version <= 0 || openInResources == nil)
                    .help(openInResources == nil ? "当前界面尚未提供资源管理入口" : "在资源管理器中打开此固定版本")
                }.padding(.horizontal, 16).padding(.vertical, 10)
                Divider()
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if binary { Text("此版本是二进制文件，请在完整 Artifact 管理中导出查看").foregroundStyle(.secondary) }
                        if let document { ResourceDocumentView(chunk: document) }
                        if let error {
                            Text(error).font(.caption).foregroundStyle(.secondary)
                            Button("重试读取") { beginRead() }.disabled(loading)
                        } else if offset != nil && !binary {
                            if loadedPages >= 4 {
                                Text("已达到小窗预览上限，可在资源管理中查看或导出全文").font(.caption).foregroundStyle(.secondary)
                            } else {
                                ProgressView().frame(maxWidth: .infinity).onAppear { beginRead() }.id(offset)
                            }
                        }
                    }.padding(16)
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .automatic) {
                    Button("复制已载入正文", systemImage: "doc.on.doc") { if let document { copyResourceText(document.text) } }
                        .disabled(document == nil || binary)
                }
            }
        }
        .frame(minWidth: 280, idealWidth: 600, minHeight: 320, idealHeight: 560)
        .onDisappear { visible = false; readTask?.cancel(); readTask = nil }
    }
    private func beginRead() {
        guard visible, !loading, readTask == nil else { return }
        readTask = Task { await load(); readTask = nil }
    }
    private func load() async {
        guard visible, !loading, let requested = offset, version > 0, loadedPages < 4 else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let request = ClientDetailActionRequest(requestId: UUID().uuidString, documentId: documentID, cardId: cardID,
                actionId: action.id, expectedResourceRevision: action.expectedResourceRevision,
                fields: ["version": .number(Double(version)), "contentHash": .string(hash), "offset": .number(Double(requested)), "readId": .string(readID)])
            let value = try await api.nativeBusinessPolicy.actionTransport.read(sessionID: sessionID, request: request)
            try Task.checkCancellation()
            guard visible else { return }
            guard value["artifactId"].text == artifactID, value["contentHash"].text == hash,
                  value["version"].number == Double(version), value["range"]["offset"].number == Double(requested) else { throw ClientConnectionError.invalidResponse }
            let next = value["range"]["nextOffset"].number.map(Int.init)
            guard next == nil || next! > requested else { throw ClientConnectionError.invalidResponse }
            let isBinary = value["encoding"].text == "base64"
            if !isBinary, let text = value["content"].text {
                let source = (document?.text ?? "") + text
                guard source.utf8.count <= 256 * 1024 else { throw ClientConnectionError.invalidResponse }
                let prepared = try await ResourceDocumentChunk.prepare(id: 0, text: source,
                    mimeType: value["mimeType"].text ?? "text/markdown", title: title, previous: document)
                try Task.checkCancellation()
                guard visible else { return }
                document = prepared
            }
            binary = isBinary; loadedPages += 1
            offset = next
        } catch is CancellationError { }
        catch {
            if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
                document = nil; self.error = "文档访问已失效"; offset = nil
            } else { self.error = "文档读取未完成，请重试" }
        }
    }
}
