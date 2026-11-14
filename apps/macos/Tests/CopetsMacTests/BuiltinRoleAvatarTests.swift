import AppKit
import SwiftUI
import Testing
import CorptieConversation
@testable import CorptieMac

@MainActor
struct BuiltinRoleAvatarTests {
    @Test func stableReferencesMatchTheBackendAndKeepUploads() {
        #expect(BuiltinRoleAvatarCatalog.ids.count == 6)
        #expect(BuiltinRoleAvatarCatalog.defaultReference(roleID: "assistant") == BuiltinRoleAvatarCatalog.prefix + "cartoon-dog")
        #expect(BuiltinRoleAvatarCatalog.defaultReference(roleID: "a") == BuiltinRoleAvatarCatalog.prefix + "ink-boy")
        var role = Role(roleId: "role:stable", name: "First", description: "", status: "available", systemPrompt: "",
                        capabilities: [], createdAt: "", updatedAt: "")
        let fallback = role.resolvedAvatarPath
        role.name = "Renamed"
        #expect(role.resolvedAvatarPath == fallback)
        role.avatarPath = "/tmp/custom.png"
        #expect(role.resolvedAvatarPath == "/tmp/custom.png")
        role.avatarPath = BuiltinRoleAvatarCatalog.prefix + "robot-16"
        #expect(role.resolvedAvatarPath == BuiltinRoleAvatarCatalog.prefix + "robot-16")
    }

    @Test func allIllustrationsRenderAndShareTheStaticCache() throws {
        _ = NSApplication.shared
        var pixels = Set<Data>()
        for id in BuiltinRoleAvatarCatalog.ids {
            let reference = BuiltinRoleAvatarCatalog.reference(for: id)
            let first = try #require(AvatarImageSupport.displayImage(at: reference))
            let second = try #require(AvatarImageSupport.displayImage(at: reference))
            #expect(first === second)
            #expect(first.size == CGSize(width: 128, height: 128))
            let rep = try #require(first.representations.first as? NSBitmapImageRep)
            #expect(rep.pixelsWide == 256 && rep.pixelsHigh == 256)
            pixels.insert(try #require(rep.representation(using: .png, properties: [:])))
        }
        #expect(pixels.count == 6)
        for index in 1...16 {
            let legacy = BuiltinRoleAvatarCatalog.prefix + String(format: "robot-%02d", index)
            let canonicalID = try #require(BuiltinRoleAvatarCatalog.id(from: legacy))
            let canonical = BuiltinRoleAvatarCatalog.reference(for: canonicalID)
            #expect(AvatarImageSupport.displayImage(at: legacy) === AvatarImageSupport.displayImage(at: canonical))
        }
        #expect(BuiltinRoleAvatarCatalog.id(from: BuiltinRoleAvatarCatalog.prefix + "robot-17") == nil)
    }

    @Test func nativePickerFitsACompactPopover() {
        let host = NSHostingView(rootView: RoleAvatarPicker(selectedPath: BuiltinRoleAvatarCatalog.prefix + "robot-01",
                                                          select: { _ in }, upload: {}))
        #expect(host.fittingSize.width <= 260)
        #expect(host.fittingSize.height < 320)
    }
}
