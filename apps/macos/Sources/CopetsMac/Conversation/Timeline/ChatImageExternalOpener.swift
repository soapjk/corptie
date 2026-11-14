import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

/// Opens original image bytes with the user's file association, never a backend URL.
@MainActor final class ChatImageExternalOpener {
    static let shared = ChatImageExternalOpener()
    private var pending = Set<URL>()

    func show(_ images: [ChatTimelineImage], selected: Int) {
        guard images.indices.contains(selected), let url = images[selected].displayURL,
              pending.insert(url).inserted else { return }
        Task {
            defer { pending.remove(url) }
            do {
                let data = try await ChatTimelineImageLoader.shared.data(for: url)
                let file = try await Task.detached(priority: .userInitiated) {
                    try Self.materialize(data, directory: FileManager.default.temporaryDirectory
                        .appendingPathComponent("Corptie-Message-Images", isDirectory: true))
                }.value
                guard NSWorkspace.shared.open(file) else { throw CocoaError(.fileReadUnknown) }
            } catch {
                BackendClient.shared.presentChatImageError(error)
            }
        }
    }

    nonisolated static func materialize(_ data: Data, directory: URL) throws -> URL {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let identifier = CGImageSourceGetType(source),
              let type = UTType(identifier as String), type.conforms(to: .image),
              let suffix = type.preferredFilenameExtension else { throw URLError(.cannotDecodeContentData) }
        let name = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name).appendingPathExtension(suffix)
        if !FileManager.default.fileExists(atPath: file.path) { try data.write(to: file, options: .atomic) }
        return file
    }
}
