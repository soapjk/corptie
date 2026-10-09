import SwiftUI
import Observation
import UIKit
import QuickLook
import CorptieClientCore
import CorptieConversation

/// Downloads only on explicit user intent, through the existing authenticated
/// transport (LAN and cloud relay). Quick Look owns zoom, rotation and sharing.
struct PadMessageResourceViewer: View {
    let connection: PadConnection
    let sessionID: String
    let itemID: String
    let resource: ConversationLocalResource
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var failure = false
    @State private var retry = 0

    var body: some View {
        NavigationStack {
            Group {
                if let localURL {
                    PadResourceQuickLook(url: localURL)
                } else if failure {
                    ContentUnavailableView {
                        Label("附件暂时无法打开", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text("请检查连接。文件也可能已被移除、超出大小限制，或不在此会话允许访问的范围内。")
                    } actions: {
                        Button("重试") { retry += 1 }
                    }
                } else { ProgressView("正在加载附件…") }
            }
            .navigationTitle(resource.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .task(id: retry) {
            failure = false
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("message-resource-\(UUID().uuidString)")
            do {
                let api = ClientSessionAPI(transport: try await connection.transport())
                let bytes = try await api.resource(sessionId: sessionID, itemId: itemID, path: resource.path)
                try Task.checkCancellation()
                let saved = try await Task.detached(priority: .userInitiated) {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let url = directory.appendingPathComponent(resource.fileName)
                    try bytes.write(to: url, options: [.atomic, .completeFileProtection])
                    return url
                }.value
                if Task.isCancelled { try? FileManager.default.removeItem(at: directory); return }
                localURL = saved
            } catch {
                try? FileManager.default.removeItem(at: directory)
                if !Task.isCancelled { failure = true }
            }
        }
        .onDisappear {
            if let localURL { try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent()) }
        }
    }
}

private struct PadResourceQuickLook: UIViewControllerRepresentable {
    let url: URL
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) { }
}

/// Message attachment thumbnails for the iPad timeline. Bytes are fetched once per
/// (session, managedPath), downsampled off the main actor, and the card reads a
/// ready `UIImage` (or a terminal "missing" mark). Same role as the desktop
/// `ChatTimelineImageLoader`; bounded so long conversations never grow memory.
@MainActor @Observable
final class PadMessageImageStore {
    enum Entry: Equatable { case loading, loaded(UIImage), missing }
    /// 88pt @3x is 264px; 320px keeps the thumbnail crisp without keeping the original raster.
    nonisolated static let thumbnailEdge: CGFloat = 320
    nonisolated static let capacity = 160

    private(set) var entries: [String: Entry] = [:]
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var inflight: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var scope = ""

    private static func key(_ sessionID: String, _ path: String, itemID: String? = nil) -> String {
        sessionID + "\u{0}" + (itemID ?? "") + "\u{0}" + path
    }

    func entry(sessionID: String, managedPath: String, itemID: String? = nil) -> Entry? {
        entries[Self.key(sessionID, managedPath, itemID: itemID)]
    }

    /// Idempotent per (scope, session, path): safe to call from every card appearance.
    func ensure(sessionID: String, managedPath: String, connection: PadConnection, itemID: String? = nil) {
        let currentScope = "\(connection.serverID)|\(connection.address)"
        if currentScope != scope {
            scope = currentScope
            for task in inflight.values { task.cancel() }
            inflight = [:]; order = []
            if !entries.isEmpty { entries = [:] }
        }
        let key = Self.key(sessionID, managedPath, itemID: itemID)
        guard entries[key] == nil else { return }
        entries[key] = .loading
        order.append(key)
        if order.count > Self.capacity {
            let evicted = order.removeFirst()
            inflight.removeValue(forKey: evicted)?.cancel()
            entries[evicted] = nil
        }
        inflight[key] = Task { [weak self] in
            let image: UIImage? = await {
                do {
                    let api = ClientSessionAPI(transport: try await connection.transport())
                    if let itemID {
                        let data = try await api.resource(sessionId: sessionID, itemId: itemID, path: managedPath)
                        return await Self.decode(data)
                    }
                    guard let payload = try await api.image(sessionId: sessionID, managedPath: managedPath) else { return nil }
                    return await Self.decode(payload.data)
                } catch { return nil }
            }()
            guard let self, !Task.isCancelled, self.entries[key] == .loading else { return }
            self.inflight[key] = nil
            self.entries[key] = image.map(Entry.loaded) ?? .missing
        }
    }

    nonisolated static func decode(_ data: Data) async -> UIImage? {
        guard !data.isEmpty, let source = UIImage(data: data) else { return nil }
        let size = source.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, thumbnailEdge / max(size.width, size.height))
        let target = CGSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
        return await source.byPreparingThumbnail(ofSize: target) ?? source
    }
}
