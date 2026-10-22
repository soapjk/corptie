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
    @State private var readAttempt = 0
    var body: some View {
        VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text(title).font(.headline).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("在资源管理器中打开", systemImage: "arrow.up.right.square") {
                        guard let openInResources else { return }
                        visible = false; dismiss()
                        openInResources(.init(id: artifactID, version: version, hash: hash, workId: workID))
                    }
                    .disabled(version <= 0 || openInResources == nil)
                    .help(openInResources == nil ? "当前界面尚未提供资源管理入口" : "在资源管理器中打开此固定版本")
                    Button("复制已载入正文", systemImage: "doc.on.doc") {
                        if let document { copyResourceText(document.text) }
                    }.disabled(document == nil || binary).help("复制已载入正文")
                    Button("关闭", systemImage: "xmark") { visible = false; dismiss() }.help("关闭")
                }.padding(.horizontal, 16).padding(.vertical, 10)
                    .labelStyle(.iconOnly).buttonStyle(.plain)
                Divider()
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if binary { Text("此版本是二进制文件，请在完整 Artifact 管理中导出查看").foregroundStyle(.secondary) }
                        if let document { ResourceDocumentView(chunk: document) }
                        if let error {
                            Text(error).font(.caption).foregroundStyle(.secondary)
                            Button("重试读取") { self.error = nil; readAttempt += 1 }.disabled(loading)
                        } else if offset != nil && !binary {
                            if loadedPages >= 4 {
                                Text("已达到小窗预览上限，可在资源管理中查看或导出全文").font(.caption).foregroundStyle(.secondary)
                            } else {
                                ProgressView().frame(maxWidth: .infinity)
                            }
                        }
                    }.padding(16)
                }
        }
        .frame(minWidth: 280, idealWidth: 600, minHeight: 320, idealHeight: 560)
        .task(id: readAttempt) {
            visible = true
            let attempt = readAttempt
            while !Task.isCancelled, visible, attempt == readAttempt,
                  offset != nil, !binary, error == nil, version > 0, loadedPages < 4 {
                let requested = offset
                await load(attempt: attempt)
                if offset == requested { break }
            }
        }
        .onDisappear { visible = false }
    }
    private func load(attempt: Int) async {
        guard visible, !loading, let requested = offset, version > 0, loadedPages < 4 else { return }
        loading = true; error = nil
        defer { if attempt == readAttempt { loading = false } }
        do {
            let request = ClientDetailActionRequest(requestId: UUID().uuidString, documentId: documentID, cardId: cardID,
                actionId: action.id, expectedResourceRevision: action.expectedResourceRevision,
                fields: ["version": .number(Double(version)), "contentHash": .string(hash), "offset": .number(Double(requested)), "readId": .string(readID)])
            let value = try await read(request)
            try Task.checkCancellation()
            guard visible, attempt == readAttempt else { return }
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
                guard visible, attempt == readAttempt else { return }
                document = prepared
            }
            binary = isBinary; loadedPages += 1
            offset = next
        } catch is CancellationError {
            if !Task.isCancelled, visible, attempt == readAttempt {
                self.error = "读取已中断，请重试"
            }
        }
        catch {
            guard !Task.isCancelled, visible, attempt == readAttempt else { return }
            if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
                document = nil; self.error = "文档访问已失效"; offset = nil
            } else if let failure = error as? ClientServiceFailure, failure.statusCode == 409 {
                self.error = "文档或会话状态已变化，请关闭预览后重新打开"
            } else if error is URLError {
                self.error = "连接中断，文档读取未完成"
            } else { self.error = "文档读取未完成，请重试" }
        }
    }

    /// Only a read may recover once from a transient connection/service error.
    /// Authorization, revision and local response validation never retry.
    private func read(_ request: ClientDetailActionRequest) async throws -> ClientInspectorValue {
        do { return try await api.nativeBusinessPolicy.actionTransport.read(sessionID: sessionID, request: request) }
        catch {
            try Task.checkCancellation()
            let transient: Bool
            if let failure = error as? ClientServiceFailure { transient = [502, 503, 504].contains(failure.statusCode) }
            else if let failure = error as? URLError {
                transient = [.cancelled, .networkConnectionLost, .timedOut, .cannotConnectToHost].contains(failure.code)
            } else { transient = false }
            guard transient else { throw error }
            try await Task.sleep(for: .milliseconds(150))
            guard visible else { throw CancellationError() }
            return try await api.nativeBusinessPolicy.actionTransport.read(sessionID: sessionID, request: request)
        }
    }
}
