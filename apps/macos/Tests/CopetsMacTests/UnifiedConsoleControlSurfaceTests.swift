import Foundation
import Testing
@testable import CorptieMac

struct UnifiedConsoleControlSurfaceTests {
    @Test
    func objectiveRailAndTaskToolbarExposeTheCorrectCreationFlows() throws {
        let unifiedSource = try source(named: "UnifiedConsoleView.swift")

        #expect(unifiedSource.contains("isCreatingObjective = true"))
        #expect(unifiedSource.contains("ObjectiveCreateView()"))
        #expect(unifiedSource.contains("isCreatingTask = true"))
        #expect(unifiedSource.contains("CorptieTaskCreateView("))
        #expect(unifiedSource.contains("selectedObjective == nil ? \"New Assistant Session\" : \"New Task\""))

        let createSource = try source(named: "CorptieTaskCreateView.swift")
        #expect(createSource.contains("Text(L10n(\"新建 Task\"))"))
        #expect(createSource.contains("TextField(L10n(\"Task 标题\")"))
        #expect(!createSource.contains("新建工作项"))
        #expect(!createSource.contains("工作项标题"))
    }

    @Test
    func combinedSessionAndTaskDetailUsesOneOuterScrollContainer() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let combinedStart = try #require(source.range(of: "if let taskId = session.taskId, !taskId.isEmpty"))
        let combinedEnd = try #require(source.range(
            of: "} else {\n                sessionCard(decoratesSurface: true)",
            range: combinedStart.lowerBound..<source.endIndex
        ))
        let combined = source[combinedStart.lowerBound..<combinedEnd.lowerBound]

        #expect(combined.components(separatedBy: "ScrollView {").count - 1 == 1)
        #expect(combined.contains("scrollsContent: false"))
        #expect(combined.contains("embedsInParentScroll: true"))
        #expect(!source.contains("会话恢复边界"))
        #expect(!source.contains("Provider 会话恢复限制"))
    }

    @Test
    func objectiveAndTaskColumnsShareOneNavigationCard() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let cardStart = try #require(source.range(of: "private var consoleNavigationCard: some View"))
        let cardEnd = try #require(source.range(
            of: "private var objectiveRail: some View",
            range: cardStart.lowerBound..<source.endIndex
        ))
        let card = source[cardStart.lowerBound..<cardEnd.lowerBound]

        #expect(card.contains("objectiveRail"))
        #expect(card.contains("unifiedTaskSidebar"))
        #expect(card.contains("RoundedRectangle("))
        #expect(card.contains(".regularMaterial"))
        #expect(card.contains(".shadow("))
        #expect(source.components(separatedBy: ".scrollContentBackground(.hidden)").count - 1 >= 3)
    }

    @Test
    func navigationCardWidthIsResizableAndPersisted() throws {
        #expect(ConsoleNavigationCardWidthPolicy.clamped(120) == 220)
        #expect(ConsoleNavigationCardWidthPolicy.clamped(360) == 360)
        #expect(ConsoleNavigationCardWidthPolicy.clamped(800) == 520)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains("console.navigationCard.taskColumnWidth"))
        #expect(source.contains("DragGesture(minimumDistance: 0)"))
        #expect(source.contains("NSCursor.resizeLeftRight"))
    }

    @Test
    func selectedObjectiveUsesAConnectedFolderTabShape() throws {
        let source = try source(named: "UnifiedConsoleView.swift")

        #expect(source.contains("ConnectedObjectiveTabShape(cornerRadius: 14)"))
        #expect(source.contains(".fill(taskColumnBackground)"))
        #expect(source.contains("private struct ConnectedObjectiveTabShape: Shape"))
        #expect(!source.contains("objectiveRail\n                .frame(width: 64)\n\n            Divider()"))
    }

    private func source(named name: String) throws -> String {
        let testsURL = URL(fileURLWithPath: #filePath)
        let packageRoot = testsURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CopetsMac/\(name)"),
            encoding: .utf8
        )
    }
}
