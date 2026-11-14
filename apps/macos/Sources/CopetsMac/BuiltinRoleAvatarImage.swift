import AppKit
import CorptieConversation
import SwiftUI

/// Approved illustrations are rasterized from the bundled SVG masters ahead of
/// time. Each 256px image is decoded once and shared by every avatar surface;
/// no runtime SVG renderer, network requests, timers or per-view image copies.
@MainActor
enum BuiltinRoleAvatarImage {
    private static var images: [String: NSImage] = [:]

    static func image(for reference: String) -> NSImage? {
        guard let id = BuiltinRoleAvatarCatalog.id(from: reference) else { return nil }
        if let cached = images[id] { return cached }
        guard let url = Bundle.module.url(forResource: id, withExtension: "png",
                                          subdirectory: "BuiltinRoleAvatars"),
              let data = try? Data(contentsOf: url),
              let bitmap = NSBitmapImageRep(data: data) else { return nil }
        bitmap.size = NSSize(width: 128, height: 128)
        let image = NSImage(size: bitmap.size)
        image.addRepresentation(bitmap)
        images[id] = image
        return image
    }
}

@MainActor
final class RoleAvatarSelection: ObservableObject {
    @Published var path: String
    init(path: String? = nil) { self.path = path ?? BuiltinRoleAvatarCatalog.randomReference() }
}

struct RoleAvatarPicker: View {
    let selectedPath: String
    let select: (String) -> Void
    let upload: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("选择头像")).font(.headline)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(44), spacing: 8), count: 3), spacing: 8) {
                ForEach(BuiltinRoleAvatarCatalog.ids, id: \.self) { id in
                    let reference = BuiltinRoleAvatarCatalog.reference(for: id)
                    Button { select(reference) } label: {
                        Group {
                            if let image = BuiltinRoleAvatarImage.image(for: reference) {
                                Image(nsImage: image).resizable().scaledToFill()
                            } else {
                                Image(systemName: "person.crop.circle").resizable().scaledToFit()
                            }
                        }
                            .frame(width: 40, height: 40).clipShape(Circle())
                            .padding(2)
                            .overlay(Circle().strokeBorder(BuiltinRoleAvatarCatalog.id(from: selectedPath) == id ? Color.accentColor : .clear, lineWidth: 2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(avatarLabel(for: id))
                    .accessibilityIdentifier("role-avatar-choice-\(id)")
                    .accessibilityAddTraits(BuiltinRoleAvatarCatalog.id(from: selectedPath) == id ? .isSelected : [])
                }
            }
            Divider()
            Button(L10n("上传图片…"), action: upload).accessibilityIdentifier("role-avatar-upload")
        }.padding(14)
    }
    private func avatarLabel(for id: String) -> String {
        switch id {
        case "anime-girl": L10n("少女头像")
        case "ceramic-robot": L10n("陶瓷机器人头像")
        case "elderly-man": L10n("老者头像")
        case "cartoon-dog": L10n("小狗头像")
        case "ink-boy": L10n("少年头像")
        default: L10n("像素机器人头像")
        }
    }

}
