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
    func workAvatarPickersAcceptSVGImages() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")

        for fileName in ["WorkCreateView.swift", "WorkDetailView.swift"] {
            let source = try String(
                contentsOf: sourceRoot.appendingPathComponent(fileName),
                encoding: .utf8
            )
            #expect(source.contains(".svg"), "SVG is not selectable in \(fileName)")
        }
    }
}
