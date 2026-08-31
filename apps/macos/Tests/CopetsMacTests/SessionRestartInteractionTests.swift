import Foundation
import Testing
@testable import CorptieMac

struct SessionRestartInteractionTests {
    @Test
    func selectedSessionHeaderExposesTheSharedSessionActionsMenu() throws {
        let source = try contents(of: "FloatingRootView.swift")

        #expect(source.contains("SessionContextMenuContent("))
        #expect(source.contains("accessibilityIdentifier(\"session.detail.actions\")"))
        #expect(source.contains("@State private var isRenamingSession = false"))
    }

    @Test
    func detailSessionRailExposesRestartThroughTheSharedContextMenu() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let rowStart = try #require(source.range(of: "struct DetailSessionRailRow: View"))
        let rowEnd = try #require(source.range(
            of: "private struct ProjectGroupHeader: View",
            range: rowStart.upperBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(row.contains(".contextMenu"))
        #expect(row.contains("SessionContextMenuContent(session: session"))
        #expect(row.contains("@State private var isRenaming = false"))
    }

    @Test
    func restartRemainsDiscoverableWhenTemporarilyUnavailable() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let menuStart = try #require(source.range(of: "private struct SessionContextMenuContent: View"))
        let menuEnd = try #require(source.range(
            of: "private struct LiquidGlassControlBackground: View",
            range: menuStart.upperBound..<source.endIndex
        ))
        let menu = source[menuStart.lowerBound..<menuEnd.lowerBound]

        #expect(menu.contains("Label(L10n(\"Restart Session\")"))
        #expect(menu.contains("session.actions?.restart?.available != true"))
        #expect(!menu.contains("if session.actions?.restart?.available == true"))
    }

    @Test
    func restartRequestCarriesAStableOperationKeyAndSurfacesFailures() throws {
        let source = try contents(of: "BackendClient.swift")
        let restartStart = try #require(source.range(of: "func restart(session: TaskSession)"))
        let restartEnd = try #require(source.range(
            of: "func switchProvider(session:",
            range: restartStart.upperBound..<source.endIndex
        ))
        let restart = source[restartStart.lowerBound..<restartEnd.lowerBound]

        #expect(restart.contains("\"idempotencyKey\": \"session-restart:"))
        #expect(restart.contains("failRestartActivity(for: session.id)"))
        #expect(restart.contains("Restart failed: %@"))
    }

    private func contents(of fileName: String) throws -> String {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        return try String(
            contentsOf: sourceRoot.appendingPathComponent(fileName),
            encoding: .utf8
        )
    }
}
