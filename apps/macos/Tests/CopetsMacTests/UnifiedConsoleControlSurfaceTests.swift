import Foundation
import Testing
@testable import CorptieMac

struct UnifiedConsoleControlSurfaceTests {
    @Test
    func objectiveRailAndTaskToolbarExposeTheCorrectCreationFlows() throws {
        let unifiedSource = try source(named: "UnifiedConsoleView.swift")

        #expect(unifiedSource.contains("floatingCreationMenu"))
        #expect(unifiedSource.contains("isCreatingObjective = true"))
        #expect(unifiedSource.contains("ObjectiveCreateView()"))
        #expect(unifiedSource.contains("isCreatingTask = true"))
        #expect(unifiedSource.contains("CorptieTaskCreateView("))
        #expect(unifiedSource.contains("Button(L10n(\"New Assistant Session\")"))
        #expect(unifiedSource.contains("Button(L10n(\"New Task\")"))
        #expect(unifiedSource.contains("Button(L10n(\"New Objective\")"))
        #expect(unifiedSource.contains(".overlay(alignment: .bottomTrailing)"))
        #expect(unifiedSource.contains("FloatingCreationButtonGlassModifier"))
        #expect(!unifiedSource.contains("Completed Tasks remain available until archived."))

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
        #expect(source.contains(".overlay(alignment: .trailing) {\n            navigationResizeHandle"))
    }

    @Test
    func selectedObjectiveUsesADiscordStyleEdgePill() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let iconStart = try #require(source.range(of: "private func consoleRailIcon("))
        let iconEnd = try #require(source.range(
            of: "private func objectiveInitials",
            range: iconStart.lowerBound..<source.endIndex
        ))
        let icon = source[iconStart.lowerBound..<iconEnd.lowerBound]

        #expect(icon.contains(".overlay(alignment: .leading)"))
        #expect(icon.contains("Capsule()"))
        #expect(icon.contains("isSelected || hasUnread"))
        #expect(icon.contains("isSelected ? Color.accentColor.opacity(0.78) : Color.red"))
        #expect(icon.contains("width: isSelected ? 4 : 8"))
        #expect(icon.contains("height: isSelected ? 24 : 8"))
        #expect(icon.contains(".padding(.leading, 2)"))
        #expect(!source.contains("CurvedSidebarLinkHighlight"))
        #expect(!source.contains("ConnectedObjectiveBodyShape"))
    }

    @Test
    func objectiveRailAggregatesUnreadSessionsByOwner() throws {
        let source = try source(named: "UnifiedConsoleView.swift")

        #expect(source.contains("struct ObjectiveRailUnreadSummary: Equatable"))
        #expect(source.contains("session.resolvedSessionKind == .assistantChat"))
        #expect(source.contains("objectiveIDs.insert(objectiveID)"))
        #expect(source.contains("session.archived != true"))
        #expect(source.contains("unreadSummary.hasUnreadAssistantSessions"))
        #expect(source.contains("unreadSummary.objectiveIDs.contains(objective.id)"))
    }

    @Test
    func selectedObjectiveDoesNotRestyleItsAvatar() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let iconStart = try #require(source.range(of: "private func consoleRailIcon("))
        let iconEnd = try #require(source.range(
            of: "private func objectiveInitials",
            range: iconStart.lowerBound..<source.endIndex
        ))
        let icon = source[iconStart.lowerBound..<iconEnd.lowerBound]
        let avatarEnd = try #require(icon.range(of: ".foregroundStyle(Color.primary)"))
        let avatar = icon[icon.startIndex..<avatarEnd.lowerBound]

        #expect(avatar.contains("Circle()"))
        #expect(avatar.contains(".fill(Color(nsColor: .controlBackgroundColor))"))
        #expect(!avatar.contains("isSelected ? Color.clear"))
        #expect(!avatar.contains("Color.accentColor"))
    }

    @Test
    func objectiveRailScrollsWithoutIndicatorsAndKeepsSelectionVisible() throws {
        let source = try source(named: "UnifiedConsoleView.swift")

        #expect(source.contains("ScrollView(.vertical, showsIndicators: false)"))
        #expect(source.contains("private var objectiveRailScrollMask: some View"))
        #expect(source.contains("proxy.scrollTo(selectedObjectiveId, anchor: .center)"))
        #expect(source.contains(".padding(.vertical, 10)"))
        #expect(!source.contains("ObjectiveRailItemFramePreferenceKey"))
    }

    @Test
    func selectedTaskUsesACompactInsetLowRadiusBackground() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "private func taskRow("))
        let rowEnd = try #require(source.range(
            of: "private func openTask(",
            range: rowStart.lowerBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(row.contains("RoundedRectangle(cornerRadius: 5, style: .continuous)"))
        #expect(row.contains(".padding(.horizontal, 8)"))
        #expect(!row.contains("RoundedRectangle(cornerRadius: 10"))
    }

    @Test
    func taskRowsUseOneLineAndDoNotExposeSessionStartupAsTaskState() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "private func taskRow("))
        let rowEnd = try #require(source.range(
            of: "private func openTask(",
            range: rowStart.lowerBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(row.contains("Text(task.title)"))
        #expect(row.contains(".lineLimit(1)"))
        #expect(!row.contains("L10n(\"Not started\")"))
        #expect(!row.contains("Text(session == nil"))
        #expect(!row.contains("Text(task.lifecycleState)"))
    }

    @Test
    func pendingSessionMessageAreaDoesNotAddAnEmptyStateCard() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let pendingStart = try #require(source.range(of: "} else if let task = selectedTask {"))
        let pendingEnd = try #require(source.range(
            of: "} else {\n            ContentUnavailableView(",
            range: pendingStart.lowerBound..<source.endIndex
        ))
        let pendingState = source[pendingStart.lowerBound..<pendingEnd.lowerBound]

        #expect(pendingState.contains("The companion Work Session is being prepared."))
        #expect(!pendingState.contains(".background(.regularMaterial"))
        #expect(!pendingState.contains("RoundedRectangle(cornerRadius: 12"))
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
