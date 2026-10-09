import SwiftUI
import Observation
import UIKit
import QuickLook
import ImageIO
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

struct PadResourceQuickLook: UIViewControllerRepresentable {
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
    nonisolated static let thumbnailEdge: CGFloat = 1024
    nonisolated static let capacity = 160

    private(set) var entries: [String: Entry] = [:]
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var inflight: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var scope = ""
    @ObservationIgnored private var pending: [(String, @MainActor () async -> UIImage?)] = []
    @ObservationIgnored private var byteCosts: [String: Int] = [:]
    @ObservationIgnored private var totalBytes = 0
    private static let maximumBytes = 64 * 1024 * 1024

    func retry(sessionID: String, managedPath: String, connection: PadConnection, itemID: String? = nil) {
        let key = Self.key(sessionID, managedPath, itemID: itemID)
        guard entries[key] == .missing else { return }
        entries[key] = nil
        order.removeAll { $0 == key }
        ensure(sessionID: sessionID, managedPath: managedPath, connection: connection, itemID: itemID)
    }

    private static func key(_ sessionID: String, _ path: String, itemID: String? = nil) -> String {
        sessionID + "\u{0}" + (itemID ?? "") + "\u{0}" + path
    }

    func entry(sessionID: String, managedPath: String, itemID: String? = nil) -> Entry? {
        entries[Self.key(sessionID, managedPath, itemID: itemID)]
    }

    /// Idempotent per (scope, session, path): safe to call from every card appearance.
    func ensure(sessionID: String, managedPath: String, connection: PadConnection, itemID: String? = nil) {
        let currentScope = "\(connection.serverID)|\(connection.deviceID ?? "")|\(connection.address)"
        if currentScope != scope {
            scope = currentScope
            for task in inflight.values { task.cancel() }
            inflight = [:]; order = []; pending = []; byteCosts = [:]; totalBytes = 0
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
            pending.removeAll { $0.0 == evicted }
            totalBytes -= byteCosts.removeValue(forKey: evicted) ?? 0
        }
        pending.append((key, {
                do {
                    if let url = URL(string: managedPath), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                        let data = try await ClientRemoteImageDownload.read(url)
                        return await Self.decode(data)
                    }
                    let api = ClientSessionAPI(transport: try await connection.transport())
                    if let itemID {
                        let data = try await api.resource(sessionId: sessionID, itemId: itemID, path: managedPath)
                        return await Self.decode(data)
                    }
                    guard let payload = try await api.image(sessionId: sessionID, managedPath: managedPath) else { return nil }
                    return await Self.decode(payload.data)
                } catch { return nil }
        }))
        drain()
    }

    private func drain() {
        while inflight.count < 3, !pending.isEmpty {
            let (key, load) = pending.removeFirst()
            inflight[key] = Task { [weak self] in
                let image = await load()
                guard let self, !Task.isCancelled, self.entries[key] == .loading else { return }
                self.inflight[key] = nil
                let cost = image?.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
                self.byteCosts[key] = cost
                self.totalBytes += cost
                self.entries[key] = image.map(Entry.loaded) ?? .missing
                while self.totalBytes > Self.maximumBytes, let evicted = self.order.first {
                    self.order.removeFirst()
                    self.inflight.removeValue(forKey: evicted)?.cancel()
                    self.pending.removeAll { $0.0 == evicted }
                    self.entries[evicted] = nil
                    self.totalBytes -= self.byteCosts.removeValue(forKey: evicted) ?? 0
                }
                self.drain()
            }
        }
    }

    nonisolated static func decode(_ data: Data) async -> UIImage? {
        let bitmap = await Task.detached(priority: .utility) {
            guard !data.isEmpty, data.count <= 20 * 1024 * 1024,
                  let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil as CGImage? }
            return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: thumbnailEdge,
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary)
        }.value
        return bitmap.map { UIImage(cgImage: $0) }
    }
}
