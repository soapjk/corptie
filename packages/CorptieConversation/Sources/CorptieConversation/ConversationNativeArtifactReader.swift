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
    @Environment(\.dismiss) private var dismiss
    @State private var readID = UUID().uuidString
    @State private var chunks: [Chunk] = []
    @State private var offset: Int? = 0
    @State private var loading = false
    @State private var error: String?
    @State private var binary = false
    @State private var clipped = false
    private struct Chunk: Identifiable { let id: Int; let text: String }
    var body: some View {
        NavigationStack {
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if clipped { Text("较早内容已移出预览窗口，可关闭后重新打开回到开头").font(.caption).foregroundStyle(.secondary).padding(.bottom, 12) }
                    if binary { Text("此版本是二进制文件，请在完整 Artifact 管理中导出查看").foregroundStyle(.secondary) }
                    ForEach(chunks) { chunk in Text(chunk.text).font(.system(size: 12)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    if let error {
                        Text(error).font(.caption).foregroundStyle(.secondary)
                        Button("重试读取") { Task { await load() } }
                    } else if offset != nil && !binary {
                        ProgressView().frame(maxWidth: .infinity).onAppear { Task { await load() } }.id(offset)
                    }
                }.padding(16)
            }
            .navigationTitle(title)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } } }
        }
        .frame(minWidth: 280, idealWidth: 600, minHeight: 320, idealHeight: 560)
    }
    private func load() async {
        guard !loading, let requested = offset, version > 0 else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let request = ClientDetailActionRequest(requestId: UUID().uuidString, documentId: documentID, cardId: cardID,
                actionId: action.id, expectedResourceRevision: action.expectedResourceRevision,
                fields: ["version": .number(Double(version)), "contentHash": .string(hash), "offset": .number(Double(requested)), "readId": .string(readID)])
            let value = try await api.nativeBusinessPolicy.actionTransport.read(sessionID: sessionID, request: request)
            try Task.checkCancellation()
            guard value["artifactId"].text == artifactID, value["contentHash"].text == hash,
                  value["version"].number == Double(version), value["range"]["offset"].number == Double(requested) else { throw ClientConnectionError.invalidResponse }
            let next = value["range"]["nextOffset"].number.map(Int.init)
            guard next == nil || next! > requested else { throw ClientConnectionError.invalidResponse }
            binary = value["encoding"].text == "base64"
            if !binary, let text = value["content"].text { chunks.append(.init(id: requested, text: text)) }
            while chunks.count > 32 { chunks.removeFirst(); clipped = true }
            offset = next
        } catch is CancellationError { }
        catch {
            if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
                chunks = []; self.error = "文档访问已失效"; offset = nil
            } else { self.error = "文档读取未完成，请重试" }
        }
    }
}
