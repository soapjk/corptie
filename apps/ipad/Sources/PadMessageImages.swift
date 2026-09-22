import SwiftUI
import Observation
import UIKit
import CorptieClientCore
import CorptieConversation

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

    private static func key(_ sessionID: String, _ path: String) -> String { sessionID + "\u{0}" + path }

    func entry(sessionID: String, managedPath: String) -> Entry? {
        entries[Self.key(sessionID, managedPath)]
    }

    /// Idempotent per (scope, session, path): safe to call from every card appearance.
    func ensure(sessionID: String, managedPath: String, connection: PadConnection) {
        let currentScope = "\(connection.serverID)|\(connection.address)"
        if currentScope != scope {
            scope = currentScope
            for task in inflight.values { task.cancel() }
            inflight = [:]; order = []
            if !entries.isEmpty { entries = [:] }
        }
        let key = Self.key(sessionID, managedPath)
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
