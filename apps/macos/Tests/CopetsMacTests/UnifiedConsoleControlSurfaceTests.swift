import Foundation
import Testing
@testable import CorptieMac

struct UnifiedConsoleControlSurfaceTests {
    @Test
    func consoleUsesCompactConsistentOuterAndColumnSpacing() throws {
        #expect(MainWindowPageLayoutMetrics.outerPadding == 6)
        #expect(MainWindowPageLayoutMetrics.columnSpacing == 6)
        #expect(MainWindowPageLayoutMetrics.cardCornerRadius == 10)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains(".padding(.leading, MainWindowPageLayoutMetrics.outerPadding)"))
        #expect(source.contains(".padding(.vertical, MainWindowPageLayoutMetrics.outerPadding)"))
        #expect(source.components(
            separatedBy: "HStack(spacing: MainWindowPageLayoutMetrics.columnSpacing)"
        ).count - 1 == 2)
        #expect(source.components(
            separatedBy: ".padding(MainWindowPageLayoutMetrics.outerPadding)"
        ).count - 1 == 2)
    }

    @Test
    func automationAndWorktreePagesShareCompactCardGeometry() throws {
        let automation = try source(named: "AutomationsView.swift")
        let worktree = try source(named: "WorktreeManagementView.swift")

        #expect(automation.contains(".padding(MainWindowPageLayoutMetrics.outerPadding)"))
        #expect(automation.components(separatedBy: ".mainWindowPageCard()").count - 1 == 2)
        #expect(automation.contains("MainWindowPageLayoutMetrics.halfColumnSpacing"))

        #expect(worktree.contains(".padding(MainWindowPageLayoutMetrics.outerPadding)"))
        #expect(worktree.components(separatedBy: ".mainWindowPageCard()").count - 1 == 3)
        #expect(worktree.components(
            separatedBy: "MainWindowPageLayoutMetrics.halfColumnSpacing"
        ).count - 1 == 3)
    }

    @Test
    func messageComposerStaysVisuallyStableWhileSubmissionIsGuarded() throws {
        let source = try source(named: "FloatingRootView.swift")
        let start = try #require(source.range(of: "struct MessageComposer: View"))
        let end = try #require(source.range(
            of: "enum ComposerInputLayout",
            range: start.upperBound..<source.endIndex
        ))
        let composer = source[start.lowerBound..<end.lowerBound]

        #expect(composer.contains(".disabled(false)"))
        #expect(composer.contains("|| backendClient.isSendingMessage"))
        #expect(composer.contains("!backendClient.isSendingMessage else"))
        #expect(!composer.contains(".opacity(!backendClient.selectedCanSendNow"))
    }

    @Test
    func workRailAndTaskToolbarExposeTheCorrectCreationFlows() throws {
        let unifiedSource = try source(named: "UnifiedConsoleView.swift")

        #expect(unifiedSource.contains("floatingCreationMenu"))
        #expect(unifiedSource.contains("isCreatingWork = true"))
        #expect(unifiedSource.contains("WorkCreateView()"))
        #expect(unifiedSource.contains("isCreatingTask = true"))
        #expect(unifiedSource.contains("CorptieTaskCreateView("))
        #expect(unifiedSource.contains("Button(L10n(\"New Assistant Session\")"))
        #expect(unifiedSource.contains("Button(L10n(\"New Task\")"))
        #expect(unifiedSource.contains("Button(L10n(\"New Work\")"))
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
    func workCreationRequiresAnAgentAndDoesNotOfferATargetDate() throws {
        let createSource = try source(named: "WorkCreateView.swift")

        #expect(createSource.contains("|| contributorAgentIds.isEmpty"))
        #expect(createSource.contains("guard !trimmed.isEmpty, !contributorAgentIds.isEmpty"))
        #expect(createSource.contains("请至少选择一个 Contributor Agent"))
        #expect(createSource.contains("Button(L10n(\"选择头像\"))"))
        #expect(createSource.contains("avatarPath: requestAvatarSourcePath"))
        #expect(!createSource.contains("targetDate"))
        #expect(!createSource.contains("DatePicker("))
        #expect(!createSource.contains("工作类型"))
        #expect(!createSource.contains("requestProfile"))

        let resourcesSource = try source(named: "WorkResourcesEditor.swift")
        #expect(resourcesSource.contains("每个 Workspace 只能绑定一个 Work"))
        #expect(resourcesSource.contains("client.works.first(where:"))

        let detailSource = try source(named: "WorkDetailView.swift")
        #expect(detailSource.contains("client.setWorkAvatar"))
        #expect(detailSource.contains("client.clearWorkAvatar"))
        #expect(!detailSource.contains("hasTargetDate"))
        #expect(!detailSource.contains("targetDate:"))
        #expect(!detailSource.contains("DatePicker("))
        #expect(!detailSource.contains("设置目标日期"))
        #expect(!detailSource.contains("工作类型"))
        #expect(!detailSource.contains("profile: profile"))

        let consoleSource = try source(named: "UnifiedConsoleView.swift")
        #expect(consoleSource.contains("avatarPath: work.avatarPath"))
        #expect(consoleSource.contains("ObjectiveAvatarView("))
        #expect(consoleSource.contains("objectiveID: work.id"))
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
    func workAndTaskColumnsShareOneNavigationCard() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let cardStart = try #require(source.range(of: "private var consoleNavigationCard: some View"))
        let cardEnd = try #require(source.range(
            of: "private var workRail: some View",
            range: cardStart.lowerBound..<source.endIndex
        ))
        let card = source[cardStart.lowerBound..<cardEnd.lowerBound]

        #expect(card.contains("workRail"))
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
    func selectedWorkUsesADiscordStyleEdgePill() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let iconStart = try #require(source.range(of: "private func consoleRailIcon("))
        let iconEnd = try #require(source.range(
            of: "private func workInitials",
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
        #expect(!source.contains("ConnectedWorkBodyShape"))
    }

    @Test
    func workRailAggregatesUnreadSessionsByOwner() throws {
        let source = try source(named: "UnifiedConsoleView.swift")

        #expect(source.contains("struct WorkRailUnreadSummary: Equatable"))
        #expect(source.contains("session.resolvedSessionKind == .assistantChat"))
        #expect(source.contains("workIDs.insert(workID)"))
        #expect(source.contains("session.archived != true"))
        #expect(source.contains("unreadSummary.hasUnreadAssistantSessions"))
        #expect(source.contains("unreadSummary.workIDs.contains(work.id)"))
    }

    @Test
    func selectedWorkDoesNotRestyleItsAvatar() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let iconStart = try #require(source.range(of: "private func consoleRailIcon("))
        let iconEnd = try #require(source.range(
            of: "private func workInitials",
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
    func workRailScrollsWithoutIndicatorsAndKeepsSelectionVisible() throws {
        let source = try source(named: "UnifiedConsoleView.swift")

        #expect(source.contains("ScrollView(.vertical, showsIndicators: false)"))
        #expect(source.contains("private var workRailScrollMask: some View"))
        #expect(source.contains("proxy.scrollTo(selectedWorkId, anchor: .center)"))
        #expect(source.contains(".padding(.vertical, 10)"))
        #expect(!source.contains("WorkRailItemFramePreferenceKey"))
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
    func workChatUsesTheSameSingleLineVisualContractAsTaskRows() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "private func workChatRow("))
        let rowEnd = try #require(source.range(
            of: "private func taskRow(",
            range: rowStart.lowerBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(source.contains("workChatRow(row)"))
        #expect(!source.contains("sessionRow(row, subtitle: L10n(\"Work discussion\"))"))
        #expect(row.contains("HStack(spacing: 9)"))
        #expect(row.contains(".frame(width: 7, height: 7)"))
        #expect(row.contains(".font(.system(size: 12, weight: .semibold))"))
        #expect(row.contains(".lineLimit(1)"))
        #expect(row.contains("RoundedRectangle(cornerRadius: 5, style: .continuous)"))
        #expect(row.contains("SessionContextMenuContent("))
    }

    @Test
    func taskRowsExposeUnreadStateFromTheirBoundSession() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "private func taskRow("))
        let rowEnd = try #require(source.range(
            of: "private func openTask(",
            range: rowStart.lowerBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(row.contains("if let session, isSessionUnread(session)"))
        #expect(row.contains(".fill(Color.red)"))
        #expect(row.contains(".accessibilityLabel(L10n(\"Unread Session\"))"))
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
