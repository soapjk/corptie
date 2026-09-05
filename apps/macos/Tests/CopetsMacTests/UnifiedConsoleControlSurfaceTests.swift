import Foundation
import Testing
@testable import CorptieMac

struct UnifiedConsoleControlSurfaceTests {
    @Test
    func workingWorkTitleUsesTimeDrivenSeamlessGradientMotion() throws {
        #expect(ConsoleWorkOutlineMetrics.workingGradientFrameInterval == 1.0 / 24.0)
        #expect(ConsoleWorkFlowingGradientPolicy.progress(
            at: Date(timeIntervalSinceReferenceDate: 0)
        ) == 0)
        #expect(ConsoleWorkFlowingGradientPolicy.progress(
            at: Date(timeIntervalSinceReferenceDate: ConsoleWorkOutlineMetrics.workingGradientDuration / 2)
        ) == 0.5)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains("TimelineView(.animation("))
        #expect(source.contains("proxy.size.width * (progress - 1)"))
        #expect(source.contains(".mask(Text(title))"))
        #expect(source.contains("accessibilityReduceMotion"))
        #expect(!source.contains("hasAdvancedGradient"))
    }

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
    func workNavigationHeaderUsesLiteralTitleAndHostsLayoutToggleBesideSearch() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let start = try #require(source.range(of: "private var unifiedWorkOutlineSidebar: some View"))
        let end = try #require(source.range(
            of: "    private var workOutlineList: some View",
            range: start.upperBound..<source.endIndex
        ))
        let outlineSidebar = source[start.lowerBound..<end.lowerBound]

        #expect(outlineSidebar.contains("Text(verbatim: \"Work\")"))
        let togglePosition = try #require(outlineSidebar.range(of: "navigationModeToggle"))
        let searchPosition = try #require(outlineSidebar.range(of: "searchToggleButton"))
        #expect(togglePosition.lowerBound < searchPosition.lowerBound)
        #expect(!source.contains(".overlay(alignment: .bottomLeading) {\n            navigationModeToggle"))
    }

    @Test
    func taskRowShowsAnAccessibleAlarmOnlyForPendingScheduledWakeProjection() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let start = try #require(source.range(of: "private func taskRow(_ task: CorptieTask"))
        let end = try #require(source.range(
            of: "    @ViewBuilder\n    private func taskContextMenuContent",
            range: start.upperBound..<source.endIndex
        ))
        let taskRow = source[start.lowerBound..<end.lowerBound]

        #expect(taskRow.contains("if task.hasPendingScheduledWake == true"))
        #expect(taskRow.contains("Image(systemName: \"alarm\")"))
        #expect(taskRow.contains(".accessibilityLabel(L10n(\"存在等待执行的计划任务\"))"))
        #expect(taskRow.contains(".help(L10n(\"存在等待执行的计划任务\"))"))
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
        let sessionComposerStart = try #require(source.range(of: "private var sessionComposer: some View"))
        let sessionComposerEnd = try #require(source.range(
            of: "    var body: some View",
            range: sessionComposerStart.upperBound..<source.endIndex
        ))
        let sessionComposer = source[sessionComposerStart.lowerBound..<sessionComposerEnd.lowerBound]
        let start = try #require(source.range(of: "struct MessageComposer: View"))
        let end = try #require(source.range(
            of: "enum ComposerInputLayout",
            range: start.upperBound..<source.endIndex
        ))
        let composer = source[start.lowerBound..<end.lowerBound]

        #expect(sessionComposer.contains("MessageComposer("))
        #expect(!sessionComposer.contains("else if !sessionIsReady"))
        #expect(!sessionComposer.contains("ReadOnlyComposer(\n                reason: composerUnavailableReason"))
        #expect(composer.contains(".disabled(false)"))
        #expect(composer.contains("|| backendClient.isSendingMessage"))
        #expect(composer.contains("!backendClient.isSendingMessage else"))
        #expect(!composer.contains(".opacity(!backendClient.selectedCanSendNow"))
    }

    @Test
    func unavailableSessionExplainsTheDisabledComposerAndOffersRecovery() throws {
        let source = try source(named: "FloatingRootView.swift")
        let noticeStart = try #require(source.range(of: "private struct SessionNotReadyComposerNotice: View"))
        let noticeEnd = try #require(source.range(
            of: "private struct ReadOnlyComposer: View",
            range: noticeStart.upperBound..<source.endIndex
        ))
        let notice = source[noticeStart.lowerBound..<noticeEnd.lowerBound]

        #expect(source.contains("sessionReadinessNotice"))
        #expect(source.contains("!session.isReady"))
        #expect(notice.contains("session.notReadyReason?.presentationMessage"))
        #expect(notice.contains("session.actions?.restart?.available == true"))
        #expect(notice.contains("backendClient.restart(session: session)"))
        #expect(notice.contains("commandState.restartingSessionIds.contains(session.id)"))
    }

    @Test
    func messageComposerOffersKeyboardAccessibleOneTurnMentions() throws {
        #expect(ComposerMentionMenuMetrics.width == 360)
        #expect(ComposerMentionMenuMetrics.height(candidateCount: 0) == 180)
        #expect(ComposerMentionMenuMetrics.height(candidateCount: 1) == 180)
        #expect(ComposerMentionMenuMetrics.height(candidateCount: 10) == 326)

        let source = try source(named: "FloatingRootView.swift")
        let start = try #require(source.range(of: "struct MessageComposer: View"))
        let end = try #require(source.range(
            of: "enum ComposerInputLayout",
            range: start.upperBound..<source.endIndex
        ))
        let composer = source[start.lowerBound..<end.lowerBound]

        #expect(source.contains("Mention a Work or Session"))
        #expect(composer.contains("targetType: .work"))
        #expect(composer.contains("targetType: .session"))
        #expect(composer.contains("mentions: submittedMentions"))
        #expect(!composer.contains("Button(action: beginMention)"))
        #expect(source.contains("onMentionCommand?(.move(1))"))
        #expect(source.contains("onMentionCommand?(.select)"))
        #expect(source.contains("onMentionCommand?(.dismiss)"))
        #expect(source.contains("LazyVStack(spacing: 2)"))
        #expect(composer.contains(".popover("))
        #expect(composer.contains("attachmentAnchor: .point(mentionAnchorPoint)"))
        #expect(composer.contains("onMentionAnchorChange: { mentionAnchorPoint = $0 }"))
        #expect(source.contains("layoutManager.boundingRect("))
        #expect(composer.contains("arrowEdge: .bottom"))
        #expect(composer.contains("mentionMenuPresented"))
        #expect(source.contains("ScrollViewReader { proxy in"))
        #expect(source.contains("proxy.scrollTo(candidates[index].id, anchor: .center)"))
        #expect(source.contains(".accessibilityAddTraits(index == selectedIndex ? .isSelected : [])"))
        #expect(!composer.contains(".offset(x: 8, y:"))
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
        #expect(unifiedSource.contains("presentTaskCreation(for: work.id)"))
        #expect(unifiedSource.contains("private struct HoverRevealHeaderAction<Header: View>: View"))
        #expect(unifiedSource.contains(".opacity(isHovering || isFocused ? 1 : 0)"))
        #expect(unifiedSource.contains(".focused($isFocused)"))
        #expect(unifiedSource.contains(".onHover { isHovering = $0 }"))
        #expect(unifiedSource.contains("accessibilityLabel: L10n(\"New Assistant Session\")"))
        #expect(unifiedSource.contains("action: { showNewSessionCreation = true }"))
        #expect(unifiedSource.contains("Create Task in %@"))
        #expect(unifiedSource.contains(".overlay(alignment: .bottomTrailing)"))
        #expect(unifiedSource.contains("FloatingCreationButtonGlassModifier"))
        #expect(!unifiedSource.contains("Completed Tasks remain available until archived."))

        let createSource = try source(named: "CorptieTaskCreateView.swift")
        #expect(createSource.contains("Text(L10n(\"新建 Task\"))"))
        #expect(createSource.contains("TextField(L10n(\"Task 标题\")"))
        #expect(createSource.contains("Picker(L10n(\"Work\"), selection: $selectedWorkId)"))
        #expect(createSource.contains("initialWorkId: String? = nil"))
        #expect(!createSource.contains("新建工作项"))
        #expect(!createSource.contains("工作项标题"))
        #expect(!unifiedSource.contains("outlineGroupEmptyRow(L10n(\"No Tasks\"))"))
    }

    @Test
    func workCreationRequiresAnAgentAndDoesNotOfferATargetDate() throws {
        let createSource = try source(named: "WorkCreateView.swift")

        #expect(createSource.contains("|| contributorAgentIds.isEmpty"))
        #expect(createSource.contains("guard EntityNamePolicy.isValid(name), !contributorAgentIds.isEmpty"))
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
    func taskInformationDoesNotRepeatSessionWorkspaceOrShowLegacyGoal() throws {
        let source = try source(named: "WarRoomView.swift")
        let detailStart = try #require(source.range(of: "private var detailContent: some View"))
        let detailEnd = try #require(source.range(
            of: "private var detailHeader: some View",
            range: detailStart.upperBound..<source.endIndex
        ))
        let detail = source[detailStart.lowerBound..<detailEnd.lowerBound]

        let overviewStart = try #require(source.range(of: "private var overviewSection: some View"))
        let overviewEnd = try #require(source.range(
            of: "private func creationOriginLabel",
            range: overviewStart.upperBound..<source.endIndex
        ))
        let overview = source[overviewStart.lowerBound..<overviewEnd.lowerBound]

        #expect(!detail.contains("title: L10n(\"Goal\")"))
        #expect(!detail.contains("text: task.goal"))
        #expect(!overview.contains("L10n(\"WORKSPACE\")"))
        #expect(!overview.contains("workspaceName"))
        #expect(!overview.contains("Text(task.title)"))
        #expect(!source.contains("private var workspaceName: String?"))

        let overviewPosition = try #require(detail.range(of: "overviewSection"))
        let definitionPosition = try #require(detail.range(of: "taskDefinitionSection"))
        let executionPosition = try #require(detail.range(of: "executionAndWorkspaceSection"))
        let resourcesPosition = try #require(detail.range(of: "taskResourcesSection"))
        #expect(overviewPosition.lowerBound < definitionPosition.lowerBound)
        #expect(definitionPosition.lowerBound < executionPosition.lowerBound)
        #expect(executionPosition.lowerBound < resourcesPosition.lowerBound)
        #expect(detail.components(separatedBy: "Divider()").count - 1 == 3)
        #expect(source.contains("private var taskDefinitionSection: some View"))
        #expect(source.contains("private var executionAndWorkspaceSection: some View"))
        #expect(source.contains("private var taskResourcesSection: some View"))
    }

    @Test
    func detailRailCompactsEmptySectionsAndSharesReferencePresentation() throws {
        let taskSource = try source(named: "WarRoomView.swift")
        let sessionSource = try source(named: "UnifiedConsoleView.swift")
        let artifactSource = try source(named: "ArtifactViews.swift")
        let styleSource = try source(named: "DetailRailStyles.swift")

        #expect(taskSource.contains("if hasTaskDefinitionContent"))
        #expect(taskSource.contains("if hasContent(task.description)"))
        #expect(taskSource.contains("if hasContent(task.acceptanceCriteria)"))
        #expect(taskSource.contains("if hasContent(task.verificationCriteria)"))
        #expect(!taskSource.contains("text.isEmpty ? L10n(\"No Content\")"))
        #expect(!taskSource.contains("Text(L10n(\"暂无记忆\"))"))

        #expect(sessionSource.contains("Label(L10n(\"引用内容\"), systemImage: \"link\")"))
        #expect(artifactSource.contains("taskId == nil ? L10n(\"Artifacts\") : L10n(\"引用内容\")"))
        #expect(!sessionSource.contains("添加文件、网页或 Corptie 对象，作为这个会话的持续上下文。"))
        #expect(!artifactSource.contains("Text(L10n(\"No private Artifacts are referenced.\"))"))

        #expect(sessionSource.contains(".detailRailSectionLabelStyle()"))
        #expect(sessionSource.contains(".detailRailReferenceRowStyle()"))
        #expect(artifactSource.contains(".detailRailSectionLabelStyle()"))
        #expect(artifactSource.contains(".detailRailReferenceRowStyle()"))
        #expect(styleSource.contains("cornerRadius: 8, style: .continuous"))
    }

    @Test
    func runtimeEnvironmentShowsOnlyProviderAgentAndWorkspace() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let contentStart = try #require(source.range(of: "private var sessionDetailContent: some View"))
        let contentEnd = try #require(source.range(
            of: "private var statusCard: some View",
            range: contentStart.upperBound..<source.endIndex
        ))
        let content = source[contentStart.lowerBound..<contentEnd.lowerBound]
        let fieldsStart = try #require(source.range(of: "private var runtimeFields:"))
        let fieldsEnd = try #require(source.range(
            of: "private var agentDisplayName:",
            range: fieldsStart.upperBound..<source.endIndex
        ))
        let fields = source[fieldsStart.lowerBound..<fieldsEnd.lowerBound]

        #expect(content.contains("detailSection(title: \"运行环境\""))
        #expect(content.contains("providerPicker"))
        #expect(content.contains("detailFields(runtimeFields)"))
        #expect(content.components(separatedBy: "工作空间").count - 1 == 0)
        #expect(fields.contains("(\"Agent\", agentDisplayName)"))
        #expect(fields.contains("(\"工作空间\", compactPath(cwd))"))
        #expect(!fields.contains("currentModel"))
        #expect(!fields.contains("currentReasoningLevel"))
        #expect(!fields.contains("推理强度"))
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
    func navigationCanSwitchBetweenWorkRailAndExpandedWorkOutline() throws {
        #expect(ConsoleNavigationMode.resolved("workRail") == .workRail)
        #expect(ConsoleNavigationMode.resolved("workOutline") == .workOutline)
        #expect(ConsoleNavigationMode.resolved("unknown") == .workRail)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains("console.navigationCard.navigationMode"))
        #expect(source.contains("if navigationMode == .workRail"))
        #expect(source.contains("unifiedWorkOutlineSidebar"))
        #expect(source.contains("workOutlineList"))
        #expect(source.contains("outlineChatHeader"))
        #expect(source.contains("ForEach(assistantSessionRows)"))
        #expect(source.contains("collapsedOutlineWorkIDs"))
        #expect(source.contains("workChatRow(row)"))
        #expect(source.contains("taskRow(task)"))
        #expect(source.contains("Toggle(L10n(\"Navigation layout\"), isOn: usesWorkOutlineBinding)"))
        #expect(source.contains(".toggleStyle(.switch)"))
        #expect(!source.contains(".overlay(alignment: .bottomLeading)"))
        #expect(source.contains(".accessibilityValue(navigationMode.accessibilityValue)"))
    }

    @Test
    func expandedWorkOutlineUsesIndentedChildrenInsideGroupedCards() throws {
        #expect(ConsoleWorkOutlineMetrics.childIndent == 24)
        #expect(ConsoleWorkOutlineMetrics.groupCornerRadius == 8)
        #expect(ConsoleWorkOutlineMetrics.groupHorizontalInset == 6)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains("Color.black.opacity(0.065)"))
        #expect(source.contains(".padding(.leading, ConsoleWorkOutlineMetrics.childIndent)"))
        #expect(source.contains("outlineGroupEmptyRow"))
        #expect(source.contains("outlineChildSelectionBackground"))
        #expect(source.contains("static let disclosureAnimation = Animation.easeInOut(duration: 0.16)"))
        #expect(source.contains("private struct ConsoleWorkOutlineDisclosureStyle: DisclosureGroupStyle"))
        #expect(source.contains("private struct ConsoleWorkOutlineGroupCardModifier: ViewModifier"))
        #expect(source.contains("return ScrollView {"))
        #expect(source.contains("LazyVStack(alignment: .leading, spacing: 8)"))
        #expect(source.contains("DisclosureGroup(isExpanded: outlineAssistantExpandedBinding)"))
        #expect(source.contains("DisclosureGroup(isExpanded: outlineWorkExpandedBinding(work.id))"))
        #expect(source.contains(".disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())"))
        #expect(source.contains(".background(\n                Color.black.opacity(0.065),"))
        #expect(source.contains(".transition(.opacity.combined(with: .offset(y: -4)))"))
        #expect(source.components(separatedBy: ".consoleWorkOutlineGroupCard()").count - 1 == 2)
        #expect(!source.contains("ConsoleWorkOutlineCardRowModifier"))
        #expect(!source.contains("UnevenRoundedRectangle"))
        #expect(!source.contains("ConsoleAnimatedDisclosureContent"))
        #expect(!source.contains("ConsoleDisclosureHeightPreferenceKey"))
        #expect(source.components(
            separatedBy: "withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation)"
        ).count - 1 == 3)
        #expect(source.contains("Text(L10n(\"Chat\"))"))
        #expect(source.contains("Text(verbatim: \"Work\")"))
        #expect(!source.contains("Text(L10n(\"Work & Tasks\"))"))
        #expect(!source.contains("Text(L10n(\"Assistant\"))"))
    }

    @Test
    func workingWorkTitleUsesAnAccessibleFlowingColorGradient() throws {
        #expect(ConsoleWorkOutlineMetrics.workingGradientDuration == 2.6)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains("private struct ConsoleWorkTitle: View"))
        #expect(source.contains("@Environment(\\.accessibilityReduceMotion)"))
        #expect(source.contains("private struct ConsoleFlowingGradientWorkTitle: View"))
        #expect(source.contains("animates: !accessibilityReduceMotion"))
        #expect(source.contains("TimelineView(.animation("))
        #expect(source.contains("workingGradientFrameInterval"))
        #expect(source.contains("flowingTitle(progress:"))
        #expect(source.contains(".cyan, .blue, .purple, .pink, .orange, .cyan"))
        #expect(source.contains(".offset(x: proxy.size.width * (progress - 1))"))
        #expect(source.contains(".mask(Text(title))"))
        #expect(source.contains(".accessibilityLabel(title)"))
        #expect(source.contains("isWorking: processingWorkIDs.contains(work.id)"))
        #expect(!source.contains("ConsoleBreathingWorkTitle"))
        #expect(!source.contains("workingPulseMinimumOpacity"))
        #expect(!source.contains("Timer.publish"))
        #expect(!source.contains("hasAdvancedGradient"))
    }

    @Test
    func workOutlineKeepsContextMenusOnTheirNativeListRows() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let outlineStart = try #require(source.range(of: "private var workOutlineList: some View"))
        let outlineEnd = try #require(source.range(
            of: "private func outlineChatHeader",
            range: outlineStart.lowerBound..<source.endIndex
        ))
        let outline = source[outlineStart.lowerBound..<outlineEnd.lowerBound]

        #expect(outline.contains("taskRow(task)"))
        #expect(!outline.contains("workChatRow(row)"))
        #expect(!outline.contains("Start Work Chat"))
        #expect(outline.contains("sessionRow(row)"))
        #expect(outline.contains("workContextMenuContent(for: work)"))
        #expect(!source.contains("workOutlineContextMenu(for work: Work)"))
        #expect(!source.contains("ConsoleWorkOutlineContextTarget"))
        #expect(!source.contains("ConsoleRightClickMenuHitTarget"))
        #expect(outline.contains("return ScrollView"))
        #expect(outline.contains("LazyVStack"))
        #expect(outline.contains("DisclosureGroup(isExpanded:"))
        #expect(!outline.contains("Section(isExpanded:"))
    }

    @Test
    func workChatIsAnIndependentActionBesideTheWorkTitle() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let headerStart = try #require(source.range(of: "private struct ConsoleWorkOutlineHeader: View"))
        let headerEnd = try #require(source.range(
            of: "enum ConsoleTaskSelectionPolicy",
            range: headerStart.upperBound..<source.endIndex
        ))
        let header = source[headerStart.lowerBound..<headerEnd.lowerBound]

        #expect(header.contains("Button(action: toggleExpanded)"))
        #expect(header.contains("Button(action: openChat)"))
        #expect(header.contains("Button(action: createTask)"))
        #expect(header.contains(".padding(.leading, 6)"))
        #expect(header.contains("message.fill"))
        #expect(!header.contains("ellipsis.message"))
        #expect(!header.contains("bubble.left.and.bubble.right"))
        #expect(header.contains("if hasUnreadChat"))
        #expect(header.contains("isChatSelected ? Color.accentColor : Color.secondary"))

        #expect(!source.contains("workPendingNewChat"))
        #expect(!source.contains("NewSessionCreationSheet(fixedWork: work)"))
        #expect(source.contains("guard let workChat else { return }"))
        #expect(source.contains("openWorkChat(for: work, session: workChat)"))
        #expect(source.contains("private func workChatSession(for workId: String)"))
        #expect(source.contains("indexedSession ?? backendClient.sessions.first"))
        #expect(source.contains("private func openWorkChat(for work: Work, session: TaskSession)"))
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
    func chatSessionRowsUseTheSameCompactMetricsAsTaskRows() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "private struct ConsoleSessionRow: View"))
        let rowEnd = try #require(source.range(
            of: "func sessionMatchingPendingSelection(",
            range: rowStart.lowerBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(source.contains("return ConsoleSessionRow("))
        #expect(row.contains("HStack(spacing: 9)"))
        #expect(row.contains(".frame(width: 7, height: 7)"))
        #expect(row.contains(".font(.system(size: 12, weight: .semibold))"))
        #expect(row.contains(".padding(.vertical, 4)"))
        #expect(!row.contains("CompactSessionRow("))
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
