import Foundation
import Testing
@testable import CorptieMac

struct ObjectiveAvatarShapeTests {
    @Test
    func macOSIconCornerRadiusScalesWithAvatarSize() {
        #expect(MacOSAppIconGeometry.cornerRadius(for: 0) == 0)
        #expect(abs(MacOSAppIconGeometry.cornerRadius(for: 20) - 4.474) < 0.0001)
        #expect(abs(MacOSAppIconGeometry.cornerRadius(for: 52) - 11.6324) < 0.0001)
    }

    @Test
    func objectiveAvatarShrinksWithinItsExistingLayoutSlot() {
        #expect(ObjectiveAvatarGeometry.visualScale == 0.86)
        #expect(ObjectiveAvatarGeometry.displaySize(for: 42) == 36)
        #expect(ObjectiveAvatarGeometry.displaySize(for: 52) == 44)
        #expect(ObjectiveAvatarGeometry.displaySize(for: 20) == 17)
    }

    @Test
    func everyObjectiveSurfaceUsesTheSharedAvatarComponent() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")

        for fileName in [
            "UnifiedConsoleView.swift",
            "WarRoomView.swift",
            "WorkDetailView.swift",
            "WorkCreateView.swift"
        ] {
            let source = try String(
                contentsOf: sourceRoot.appendingPathComponent(fileName),
                encoding: .utf8
            )
            #expect(source.contains("ObjectiveAvatarView("), "Missing shared avatar in \(fileName)")
        }

        let component = try String(
            contentsOf: sourceRoot.appendingPathComponent("DefaultAvatarGradient.swift"),
            encoding: .utf8
        )
        #expect(component.contains("style: .continuous"))
        #expect(component.contains(".clipShape(MacOSAppIconShape())"))
    }

    @Test
    func avatarPickersAcceptSVGImagesThroughTheSharedPolicy() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")

        for fileName in ["AgentDetailView.swift", "WorkCreateView.swift", "WorkDetailView.swift"] {
            let source = try String(
                contentsOf: sourceRoot.appendingPathComponent(fileName),
                encoding: .utf8
            )
            #expect(
                source.contains("AvatarImageSupport.allowedContentTypes"),
                "Shared SVG-capable avatar types are not used in \(fileName)"
            )
        }

        let supportSource = try String(
            contentsOf: sourceRoot.appendingPathComponent("AvatarImageSupport.swift"),
            encoding: .utf8
        )
        #expect(supportSource.contains(".svg"))
    }

    @Test
    func appKitLoadsSVGAvatarContent() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-avatar-svg-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let avatarURL = directory.appendingPathComponent("avatar.svg")
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="18">
          <rect width="24" height="18" fill="#00aaff"/>
        </svg>
        """
        try Data(svg.utf8).write(to: avatarURL, options: .atomic)

        let image = try #require(AvatarImageSupport.loadImage(at: avatarURL.path))
        #expect(image.size.width == 24)
        #expect(image.size.height == 18)
    }
}
