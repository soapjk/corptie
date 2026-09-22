import SwiftUI
import Observation
import UIKit
import CorptieClientCore
import CorptieConversation

/// Work avatar raster cache for the sidebar. Bytes are fetched once per
/// (work, updatedAt), decoded and downsampled off the main actor, and the
/// outline row only ever reads a ready `UIImage`. Missing / undecodable
/// avatars fall back to the shared gradient + initials, exactly like macOS.
@MainActor @Observable
final class PadWorkAvatarStore {
    /// Downsampled edge in pixels: 22pt @3x is 66px; 96px keeps a sharp squircle
    /// without retaining the original raster.
    nonisolated static let thumbnailEdge: CGFloat = 96

    private(set) var images: [String: UIImage] = [:]
    @ObservationIgnored private var versions: [String: String] = [:]
    @ObservationIgnored private var inflight: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var scope = ""

    func image(for work: ClientWork) -> UIImage? {
        work.hasAvatar ? images[work.id] : nil
    }

    /// Idempotent per (scope, work, version): safe to call from every row appearance.
    func ensure(_ work: ClientWork, connection: PadConnection) {
        let currentScope = "\(connection.serverID)|\(connection.address)"
        if currentScope != scope {
            scope = currentScope
            for task in inflight.values { task.cancel() }
            inflight = [:]; versions = [:]
            if !images.isEmpty { images = [:] }
        }
        guard work.hasAvatar else {
            if versions.removeValue(forKey: work.id) != nil || images[work.id] != nil { images[work.id] = nil }
            inflight.removeValue(forKey: work.id)?.cancel()
            return
        }
        guard versions[work.id] != work.updatedAt else { return }
        versions[work.id] = work.updatedAt
        inflight[work.id]?.cancel()
        let workID = work.id, version = work.updatedAt
        inflight[workID] = Task { [weak self] in
            let image: UIImage? = await {
                do {
                    guard let self else { return nil }
                    let inventory = ClientInventory(transport: try await connection.transport())
                    guard let payload = try await inventory.workAvatar(id: workID) else { return nil }
                    return await Self.decode(payload.data)
                } catch { return nil }
            }()
            guard let self, !Task.isCancelled, self.versions[workID] == version else { return }
            self.inflight[workID] = nil
            if let image { self.images[workID] = image } else if self.images[workID] != nil { self.images[workID] = nil }
        }
    }

    /// Decode + thumbnail happen off-main; only the small bitmap crosses back.
    nonisolated static func decode(_ data: Data) async -> UIImage? {
        guard !data.isEmpty, let source = UIImage(data: data) else { return nil }
        let edge = thumbnailEdge
        let size = source.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, edge / max(size.width, size.height))
        let target = CGSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
        return await source.byPreparingThumbnail(ofSize: target) ?? source
    }
}

/// Sidebar leaf: identical to macOS `ObjectiveAvatarView` body; only the raster origin differs.
struct PadWorkAvatar: View {
    let work: ClientWork
    let size: CGFloat
    let image: UIImage?

    var body: some View {
        ObjectiveAvatarView(objectiveID: work.id, name: work.name, size: size,
            picture: image.map { PadAvatarPicture(image: $0, edge: ObjectiveAvatarGeometry.displaySize(for: size)) })
            .accessibilityHidden(true)
    }
}

private struct PadAvatarPicture: View {
    let image: UIImage
    let edge: CGFloat
    var body: some View {
        Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            .frame(width: edge, height: edge)
    }
}
