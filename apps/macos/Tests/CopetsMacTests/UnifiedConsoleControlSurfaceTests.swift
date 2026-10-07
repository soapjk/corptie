import Foundation
import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

struct UnifiedConsoleControlSurfaceTests {
    @Test
    func cardGroupsUpdateAutomaticallyWithoutManualRefreshAndUseNativeTaskGrid() throws {
        let console = try source(named: "UnifiedConsoleView.swift")
        let workspace = try source(named: "ConsoleCardWorkspace.swift")
        #expect(!console.contains("cardRefreshRevision"))
        #expect(!console.contains("刷新重点 Task"))
        #expect(!workspace.contains("refreshRevision"))
        #expect(!workspace.contains("rebuild(reset:"))
        for observer in [".onChange(of: tasks)", ".onChange(of: works)", ".onChange(of: sessions.map(CardSessionKey.init))"] {
            #expect(workspace.contains(observer))
        }
        #expect(workspace.contains("WorkTaskCardGrid(itemCount: visibleTasks.count, availableWidth: availableWidth)"))
        #expect(workspace.contains("ForEach(visibleTasks)"))
        #expect(workspace.contains("groupInteraction(for: work.id, availableWidth: availableWidth)"))
        #expect(!workspace.contains("ContentSizedTaskCardLayout { card(task) }"))
    }

    @MainActor
    @Test
    func workHeaderBlankAreaClicksOnlyToggleDisclosure() throws {
        _ = NSApplication.shared
        var toggles = 0
        var chatOpens = 0
        var taskCreates = 0
        let work = Work(id: "work:hit-test", workspaceId: "workspace:test", name: "Work",
            description: "", status: "active", profile: "general", tags: [], contributorAgentIds: [],
            createdAt: "", updatedAt: "")
        let host = NSHostingView(rootView: ConsoleWorkOutlineHeader(work: work,
            isExpanded: false, isSelected: false, isWorking: false, hasUnread: false,
            isChatSelected: false, isChatRunning: false, hasUnreadChat: false,
            toggleExpanded: { toggles += 1 }, openChat: { chatOpens += 1 },
            createTask: { taskCreates += 1 }))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 28),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil) }
        host.layoutSubtreeIfNeeded()

        // Click near the top, middle and bottom of the flexible blank region.
        for y in [CGFloat(2), CGFloat(14), CGFloat(26)] {
            let point = NSPoint(x: 400, y: y)
            let up = try #require(NSEvent.mouseEvent(with: .leftMouseUp, location: point,
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 0))
            let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: point,
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            window.sendEvent(down)
            window.sendEvent(up)
            // SwiftUI completes the gesture after receiving the mouse up.
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
        #expect(toggles == 3)
        #expect(chatOpens == 0)
        #expect(taskCreates == 0)
    }

    @Test
    func workHeaderEmptyAreaUsesFullHeightDisclosureButtonsOnBothClients() throws {
        let desktop = try source(named: "Console/ConsoleNavigationPolicies.swift")
        let headerStart = try #require(desktop.range(of: "struct ConsoleWorkOutlineHeader: View"))
        let headerEnd = try #require(desktop.range(of: "enum ConsoleTaskSelectionPolicy", range: headerStart.upperBound..<desktop.endIndex))
        let header = String(desktop[headerStart.lowerBound..<headerEnd.lowerBound])
        #expect(header.components(separatedBy: "Button(action: toggleExpanded)").count == 3)
        #expect(header.contains(".frame(minHeight: WorkOutlineMetrics.headerIconSize)"))
        #expect(header.contains(".accessibilityIdentifier(\"work-header-empty-\\(work.id)\")"))
        #expect(header.contains(".contentShape(Rectangle())"))
        #expect(header.contains("action: openChat"))
        #expect(header.contains("Button(action: createTask)"))
        #expect(!header.contains(".onTapGesture"))
        #expect(!header.contains(".highPriorityGesture"))

        let mobileURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ipad/Sources/PadWorkOutline.swift")
        let mobile = try String(contentsOf: mobileURL, encoding: .utf8)
        #expect(mobile.contains(".frame(minHeight: isPhone ? 28 : WorkOutlineMetrics.headerIconSize)"))
        #expect(mobile.contains(".accessibilityIdentifier(\"work-header-empty-\\(work.id)\")"))
    }

    @Test
    func quickMessagesRestoreTaskSnapshotsAndDiscardCancelledOrWrongTaskResponsesOnBothClients() throws {
        let desktop = try source(named: "Conversation/Composer/MessageComposer.swift")
        let mobileURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ipad/Sources/PadComposer.swift")
        let mobile = try String(contentsOf: mobileURL, encoding: .utf8)
        for contents in [desktop, mobile] {
            #expect(contents.contains(".items(for: scope)"))
            #expect(contents.contains(".remember(result.items, for: resolvedScope)"))
            #expect(contents.contains("!Task.isCancelled, quickMessageScope == scope"))
            #expect(contents.contains("taskID == nil || result.taskId == taskID"))
            #expect(!contents.contains("quickMessages = result.items"))
            #expect(!contents.contains("\n                quickMessages = ClientQuickMessage.defaults\n"))
        }
    }

    @Test
    func experimentalDetailsRemainOpenWithoutToggleState() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(!source.contains("showsCardTaskDetails"))
        #expect(!source.contains("显示或隐藏 Task Info"))
        #expect(source.contains("SessionDetailPanel(session: session, railWidth: 320)"))
        #expect(source.contains("SessionCorptieTaskDetailCard(taskId: task.id)"))
        #expect(source.contains("ConsoleWindowSplitView(mode: navigationMode"))
    }

    @Test
    func backgroundRefreshCannotChooseAnotherTaskAsDefault() throws {
        #expect(ConsoleSelectionRefreshPolicy.permitsAutomaticDefaultSelection(
            selectedTaskID: nil,
            selectedSessionID: nil
        ))
        #expect(!ConsoleSelectionRefreshPolicy.permitsAutomaticDefaultSelection(
            selectedTaskID: "task:current",
            selectedSessionID: nil
        ))
        #expect(!ConsoleSelectionRefreshPolicy.permitsAutomaticDefaultSelection(
            selectedTaskID: nil,
            selectedSessionID: "session:current"
        ))

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(!source.contains("recoverSelectionIfNeeded"))
        #expect(source.contains("CorptieTaskCreateView(initialWorkId: target.workID)"))
        #expect(source.contains("selectedTaskId = task.id"))
    }

    @Test
    func workingWorkTitleUsesTimeDrivenSeamlessGradientMotion() throws {
        #expect(ConsoleWorkOutlineMetrics.workingGradientFrameInterval == 1.0 / 24.0)
        #expect(ConsoleWorkFlowingGradientPolicy.progress(
            at: Date(timeIntervalSinceReferenceDate: 0)
        ) == 0)
        #expect(ConsoleWorkFlowingGradientPolicy.progress(
            at: Date(timeIntervalSinceReferenceDate: ConsoleWorkOutlineMetrics.workingGradientDuration / 2)
        ) == 0.5)

        let source = try source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkActivity.swift")
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
        #expect(!source.contains(".padding(.leading, MainWindowPageLayoutMetrics.outerPadding)"))
        #expect(!source.contains(".padding(.vertical, MainWindowPageLayoutMetrics.outerPadding)"))
        #expect(source.components(
            separatedBy: "HStack(spacing: MainWindowPageLayoutMetrics.columnSpacing)"
        ).count - 1 == 2)
        #expect(source.components(
            separatedBy: ".padding(MainWindowPageLayoutMetrics.outerPadding)"
        ).count - 1 == 2)
    }

    @Test
    func navigationControlsReserveAnIndependentMobileStyleToolbar() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let controlsStart = try #require(source.range(of: ".safeAreaInset(edge: .top, spacing: 0) {"))
        let controlsEnd = try #require(source.range(of: "var navigationMode:", range: controlsStart.upperBound..<source.endIndex))
        let controls = source[controlsStart.lowerBound..<controlsEnd.lowerBound]

        let togglePosition = try #require(controls.range(of: "navigationModeToggle"))
        let searchPosition = try #require(controls.range(of: "searchToggleButton"))
        let sortPosition = try #require(controls.range(of: "outlineSortMenu"))
        let archivePosition = try #require(controls.range(of: "taskArchiveToggle"))
        let createPosition = try #require(controls.range(of: "outlineCreationMenu"))
        #expect(sortPosition.lowerBound < togglePosition.lowerBound)
        #expect(togglePosition.lowerBound < searchPosition.lowerBound)
        #expect(searchPosition.lowerBound < archivePosition.lowerBound)
        #expect(archivePosition.lowerBound < createPosition.lowerBound)
        #expect(source.contains("Menu {\n            navigationModeOption(.workOutline, title: \"分组\")"))
        #expect(source.contains(".buttonStyle(.plain)\n        .menuIndicator(.hidden)"))
        #expect(source.contains(".modifier(ConsoleTopEdgeEffectModifier())"))
        #expect(controls.contains("ConsoleWorkToolbar {"))
        #expect(controls.contains("Spacer(minLength: ConsoleWorkToolbarMetrics.spacing)"))
        #expect(!controls.contains(".padding(.top, 3)"))
        #expect(ConsoleWorkToolbarMetrics.buttonDiameter == 36)
        #expect(ConsoleWorkToolbarMetrics.symbolSize == 16)
        #expect(ConsoleWorkToolbarMetrics.height == 48)
        #expect(ConsoleWorkToolbarMetrics.minimumWidth == 220)
        #expect(!source.contains("ConsoleSidebarTitlebarControls("))
        let glyph = try self.source(named: "Console/ConsoleNavigationPolicies.swift")
        #expect(glyph.contains(".platformGlassSurface(in: Circle(), interactive: true, variant: .clear)"))
        let mobile = try self.source(named: "../../../../apps/ipad/Sources/PadWorkOutline.swift")
        #expect(mobile.contains(".padGlassSurface(in: Circle(), variant: .clear)"))
        #expect(mobile.contains(".frame(width: 44, height: 44)"))
    }

    @Test @MainActor
    func workToolbarFitsNarrowSidebarWithoutShrinkingButtons() {
        let host = NSHostingView(rootView: ConsoleWorkToolbar {
            HStack(spacing: ConsoleWorkToolbarMetrics.spacing) {
                ForEach(["arrow.up.arrow.down", "rectangle.3.group", "magnifyingglass", "archivebox"], id: \.self) { symbol in
                    Button {} label: { ConsoleWorkToolbarGlyph(symbol: symbol) }.buttonStyle(.plain)
                }
            }
            Spacer(minLength: ConsoleWorkToolbarMetrics.spacing)
            Menu {} label: { ConsoleWorkToolbarGlyph(symbol: "plus") }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        })
        for width in [220.0, 300.0, 420.0] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: ConsoleWorkToolbarMetrics.height)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height == ConsoleWorkToolbarMetrics.height)
            #expect(host.fittingSize.width <= width)
        }
    }

    @Test
    func taskRowShowsAnAccessibleAlarmOnlyForPendingScheduledWakeProjection() throws {
        let host = try source(named: "Console/UnifiedConsoleWorkTaskList.swift")
        let taskRow = try source(named: "Console/ConsoleSessionRows.swift")

        #expect(host.contains("ConsoleTaskRowContent("))
        #expect(taskRow.contains("if task.hasPendingScheduledWake == true"))
        #expect(taskRow.contains("ConsoleScheduledWakeIcon()"))
        let icon = try source(named: "Console/ConsoleNavigationPolicies.swift")
        // The Mac wrapper keeps localization + tooltip; the animated body is shared with iPad.
        #expect(icon.contains("ScheduledWakeIcon(isActive: isActive, label: L10n(\"存在等待执行的计划任务\"))"))
        #expect(icon.contains(".help(L10n(\"存在等待执行的计划任务\"))"))
        let shared = try sharedSource(named: "WorkOutlineParts.swift")
        let sharedStart = try #require(shared.range(of: "public struct ScheduledWakeIcon: View"))
        let sharedIcon = shared[sharedStart.lowerBound...]
        #expect(sharedIcon.contains("Image(systemName: \"alarm\")"))
        #expect(sharedIcon.contains("AngularGradient("))
        #expect(sharedIcon.contains("paused: !isVisible || !isActive"))
        #expect(sharedIcon.contains("if reduceMotion"))
        let cards = try self.source(named: "ConsoleCardWorkspace.swift")
        let cardLabel = try self.source(named: "ConsoleConversationCardLabel.swift")
        #expect(cards.contains("hasScheduledWake: task.hasPendingScheduledWake == true"))
        #expect(cardLabel.contains("if hasScheduledWake { ConsoleScheduledWakeIcon(isActive: isActive) }"))
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
        let source = try source(named: "Conversation/SessionConversationContent.swift")
            + source(named: "Conversation/Composer/MessageComposer.swift")
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
        #expect(composer.contains("ConversationComposerChrome"))
        #expect(composer.contains("ConversationComposerEditorRow"))
        #expect(composer.contains("ThreadMetaView("))
        #expect(composer.contains("|| backendClient.isSendingMessage"))
        #expect(composer.contains("!backendClient.isSendingMessage else"))
        #expect(!composer.contains(".opacity(!backendClient.selectedCanSendNow"))
        #expect(!composer.contains(".disabled(!isReady)"))
    }

    @Test
    func jumpToLatestStaysAboveTheGlassWhileHistoryScrollsBehindIt() throws {
        let source = try source(named: "Conversation/SessionConversationContent.swift")
        let bodyStart = try #require(source.range(of: "    var body: some View"))
        let timelineStart = try #require(source.range(of: "    private func appKitDetailMessages("))
        let jumpButtonStart = try #require(source.range(of: "    private var jumpToLatestButton: some View"))
        let body = source[bodyStart.lowerBound..<timelineStart.lowerBound]
        let timeline = source[timelineStart.lowerBound..<jumpButtonStart.lowerBound]

        let jumpOverlay = try #require(body.range(of: ".overlay(alignment: .bottomTrailing) {\n                jumpToLatestButton"))
        let headerOverlay = try #require(body.range(of: ".overlay(alignment: .top) {"))
        let composerOverlay = try #require(body.range(of: ".overlay(alignment: .bottom) {"))
        #expect(headerOverlay.lowerBound < jumpOverlay.lowerBound)
        #expect(jumpOverlay.lowerBound < composerOverlay.lowerBound)
        #expect(body.contains(".padding(.bottom, composerClearance + 10)"))
        #expect(body.contains("ConversationChromeFramePreferenceKey.self"))
        #expect(body.contains("headerClearance = clearances.top"))
        #expect(timeline.contains("topClearance: headerClearance"))
        #expect(timeline.contains("bottomClearance: composerClearance"))
        #expect(!body.contains(".safeAreaInset(edge: .bottom"))
        let nativeTimeline = try self.source(named: "AppKitChatTimelineView.swift")
        let coordinator = try self.source(named: "Conversation/Timeline/AppKitChatTimelineCoordinator.swift")
        #expect(nativeTimeline.contains("scrollView.automaticallyAdjustsContentInsets = false"))
        #expect(coordinator.contains("let documentHeight = topClearance + rowsHeight + bottomClearance"))
        #expect(!coordinator.contains("scrollView.contentInsets = insets"))
        #expect(!timeline.contains(".overlay(alignment: .bottomTrailing)"))
        #expect(source.contains("if viewportState.showsJumpToLatest"))
    }

    @Test
    func unavailableSessionExplainsTheDisabledComposerAndOffersRecovery() throws {
        let source = try source(named: "Conversation/SessionConversationContent.swift")
            + source(named: "Conversation/ConversationEmptyStates.swift")
        let noticeStart = try #require(source.range(of: "struct SessionNotReadyComposerNotice: View"))
        let noticeEnd = try #require(source.range(
            of: "struct ReadOnlyComposer: View",
            range: noticeStart.upperBound..<source.endIndex
        ))
        let notice = source[noticeStart.lowerBound..<noticeEnd.lowerBound]

        #expect(source.contains("sessionReadinessNotice"))
        #expect(source.contains("session.readiness == .notReady"))
        #expect(source.contains("let reason = session.notReadyReason"))
        #expect(notice.contains("reason.presentationMessage"))
        #expect(notice.contains("reason.shouldOfferRestartRecovery"))
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

        let source = try source(named: "Conversation/Composer/MessageComposer.swift")
            + source(named: "Conversation/Composer/ComposerMenus.swift")
            + source(named: "Conversation/Composer/ComposerNativeInput.swift")
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

        #expect(unifiedSource.contains("outlineCreationMenu"))
        #expect(unifiedSource.contains("isCreatingWork = true"))
        #expect(unifiedSource.contains("WorkCreateView()"))
        #expect(unifiedSource.contains("presentTaskCreation(for: selectedWorkId)"))
        #expect(unifiedSource.contains("CorptieTaskCreateView("))
        #expect(unifiedSource.contains("Button(L10n(\"New Assistant Session\")"))
        #expect(unifiedSource.contains("Button(L10n(\"New Task\")"))
        #expect(unifiedSource.contains("Button(L10n(\"New Work\")"))
        #expect(unifiedSource.contains("presentTaskCreation(for: work.id)"))
        #expect(unifiedSource.contains("struct HoverRevealHeaderAction<Header: View>: View"))
        #expect(unifiedSource.contains(".opacity(isHovering || isFocused ? 1 : 0)"))
        #expect(unifiedSource.contains(".focused($isFocused)"))
        #expect(unifiedSource.contains(".onHover { isHovering = $0 }"))
        #expect(unifiedSource.contains("accessibilityLabel: L10n(\"New Assistant Session\")"))
        #expect(unifiedSource.contains("action: { showNewSessionCreation = true }"))
        #expect(unifiedSource.contains("Create Task in %@"))
        #expect(!unifiedSource.contains(".overlay(alignment: .bottomTrailing)"))
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

        let consoleSource = try source(named: "Console/ConsoleWorkRail.swift")
        #expect(consoleSource.contains("avatarPath: work.avatarPath"))
        #expect(consoleSource.contains("ObjectiveAvatarView("))
        #expect(consoleSource.contains("objectiveID: work.id"))
    }

    @Test
    func combinedSessionAndTaskDetailUsesOneOuterScrollContainer() throws {
        let source = try source(named: "Console/SessionDetailPanel.swift")
        let cardStart = try #require(source.range(of: "private var sessionCard: some View"))
        let detailStart = try #require(source.range(of: "private var sessionDetailContent:", range: cardStart.upperBound..<source.endIndex))
        let combined = source[cardStart.lowerBound..<detailStart.lowerBound]

        #expect(combined.contains("ConversationDetailDashboard {"))
        #expect(!combined.contains("link.badge.plus"))
        #expect(!combined.contains("ScrollView {"))
        #expect(!source.contains("Text(session.title)"))
        #expect(source.contains("embedsInParentScroll: true"))
        #expect(source.contains("if detailKind == .taskDetail, let taskId = session.taskId"))
        #expect(!source.contains("会话恢复边界"))
        #expect(!source.contains("Provider 会话恢复限制"))
    }

    @Test
    func taskInformationDoesNotRepeatSessionWorkspaceOrShowLegacyGoal() throws {
        let source = try source(named: "WorkTasks/CorptieTaskDetailView.swift")
        let detailStart = try #require(source.range(of: "private var detailContent: some View"))
        let detailEnd = try #require(source.range(
            of: "private var detailHeader: some View",
            range: detailStart.upperBound..<source.endIndex
        ))
        let detail = source[detailStart.lowerBound..<detailEnd.lowerBound]

        #expect(!detail.contains("title: L10n(\"Goal\")"))
        #expect(!detail.contains("text: task.goal"))
        #expect(!detail.contains("overviewSection"))
        #expect(!source.contains("private var workspaceName: String?"))

        let definitionPosition = try #require(detail.range(of: "ConversationTaskInformationCard("))
        let resourcesPosition = try #require(detail.range(of: "ArtifactSectionView(workId: task.workId, taskId: task.id)"))
        #expect(definitionPosition.lowerBound < resourcesPosition.lowerBound)
        #expect(detail.contains("worktreeSection.modifier(ConversationDetailModuleSurface())"))
        #expect(detail.contains("memorySection.modifier(ConversationDetailModuleSurface())"))
        #expect(!detail.contains("Divider()"))
        #expect(detail.contains("ConversationTaskInformationCard(summary: task.conversationDetailSummary"))
        #expect(!detail.contains("ConversationDetailModuleCard(title: L10n(\"Task 定义\")"))
        #expect(!source.contains("private var taskDefinitionSection: some View"))
        #expect(source.contains("private var executionAndWorkspaceSection: some View"))
        #expect(source.contains("private var taskResourcesSection: some View"))
    }

    @Test
    func detailRailCompactsEmptySectionsAndSharesReferencePresentation() throws {
        let taskSource = try source(named: "WorkTasks/CorptieTaskDetailView.swift")
        let sessionSource = try source(named: "Console/SessionDetailPanel.swift")
        let artifactSource = try source(named: "ArtifactViews.swift")
        let styleSource = try source(named: "DetailRailStyles.swift")
        let warRoomSource = try source(named: "WarRoomView.swift")
        let conversationHeaderSource = try source(named: "Conversation/ConversationHeader.swift")

        #expect(taskSource.contains("ConversationTaskInformationCard(summary: task.conversationDetailSummary"))
        #expect(!taskSource.contains("verification: task.verificationCriteria"))
        #expect(!taskSource.contains("verificationTitle:"))
        #expect(!taskSource.contains("text.isEmpty ? L10n(\"No Content\")"))
        #expect(!taskSource.contains("Text(L10n(\"暂无记忆\"))"))

        #expect(sessionSource.contains("ConversationDetailModuleCard(title: L10n(\"引用内容\"), systemImage: \"link\", headerActions:"))
        #expect(!sessionSource.contains("detailSection(title: \"执行状态\""))
        #expect(sessionSource.contains("ConversationSessionInformationCard(sessionID: session.id"))
        #expect(artifactSource.contains("taskId == nil ? L10n(\"Artifacts\") : L10n(\"Artifact 引用\")"))
        #expect(!sessionSource.contains("添加文件、网页或 Corptie 对象，作为这个会话的持续上下文。"))
        #expect(!artifactSource.contains("Text(L10n(\"No private Artifacts are referenced.\"))"))

        #expect(sessionSource.contains("ConversationDetailHeaderIcon(systemName: \"plus\")"))
        #expect(sessionSource.contains(".detailRailReferenceRowStyle()"))
        #expect(artifactSource.contains("ConversationInspectorSection(title: taskId == nil"))
        #expect(artifactSource.contains("ConversationDetailHeaderIcon(systemName: \"plus\")"))
        #expect(artifactSource.contains(".detailRailReferenceRowStyle()"))
        #expect(styleSource.contains("cornerRadius: 8, style: .continuous"))

        let detailCardStart = try #require(warRoomSource.range(of: "private var taskDetailCard: some View"))
        let detailCardEnd = try #require(warRoomSource.range(
            of: "// MARK: - Sidebar",
            range: detailCardStart.upperBound..<warRoomSource.endIndex
        ))
        let detailCard = warRoomSource[detailCardStart.lowerBound..<detailCardEnd.lowerBound]
        #expect(conversationHeaderSource.contains(".platformGlassSurface(in: Capsule())"))
        #expect(detailCard.contains(".modifier(ConversationDetailCardSurface())"))
        #expect(!detailCard.contains(".shadow("))
        #expect(!detailCard.contains("Material"))
        #expect(!detailCard.contains(".overlay"))
    }

    @Test
    func memoryRecallUsesTheSharedFullRowDisclosure() throws {
        let source = try source(named: "MemoryManagementView.swift")
        #expect(source.contains("ConversationDetailDisclosure(isExpanded: $isExpanded"))
        #expect(source.contains("Label(L10n(\"Memory recall\")"))
    }

    @Test
    func runtimeEnvironmentShowsOnlyProviderAgentAndWorkspace() throws {
        let source = try source(named: "Console/SessionDetailPanel.swift")
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

        #expect(content.contains("ConversationEnvironmentCard(provider: { providerPicker }"))
        #expect(content.contains("actions: { EmptyView() }, statusContent: { providerSwitchStatus }"))
        #expect(!content.contains("compactProviderMenu"))
        #expect(content.contains("workspacePath: session.external?.cwd"))
        #expect(fields.contains("(\"Agent\", agentDisplayName)"))
        #expect(fields.contains("(\"工作空间\", compactPath(cwd))"))
        #expect(!fields.contains("currentModel"))
        #expect(!fields.contains("currentReasoningLevel"))
        #expect(!fields.contains("推理强度"))
    }


    @Test
    func navigationRemovesClassicAndMigratesItsSavedPreference() throws {
        #expect(ConsoleNavigationMode.allCases == [.workOutline, .taskCards])
        #expect(ConsoleNavigationMode.resolved("workRail") == .workOutline)
        #expect(ConsoleNavigationMode.resolved("workOutline") == .workOutline)
        #expect(ConsoleNavigationMode.resolved("unknown") == .workOutline)

        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(source.contains("console.navigationCard.navigationMode"))
        #expect(!source.contains("if navigationMode == .workRail"))
        #expect(source.contains("unifiedWorkOutlineSidebar"))
        #expect(source.contains("workOutlineList"))
        #expect(source.contains("outlineChatHeader"))
        #expect(source.contains("ForEach(assistantSessionRows)"))
        #expect(source.contains("ConsoleOutlineExpansionPreferences"))
        #expect(source.contains("outlineExpansionPreferences.expandedWorkIDs"))
        #expect(source.contains("workChatRow(row)"))
        #expect(source.contains("taskRow(task)"))
        #expect(!source.contains("navigationModeOption(.workRail"))
        #expect(source.contains("navigationModeOption(.workOutline, title: \"分组\")"))
        #expect(source.contains("navigationModeOption(.taskCards, title: \"卡片 · 实验\")"))
        #expect(source.contains(".menuStyle(.button)"))
        #expect(!source.contains(".overlay(alignment: .bottomLeading)"))
        #expect(source.contains(".accessibilityValue(navigationMode.accessibilityValue)"))
    }

    @Test @MainActor
    func groupedOutlineExpansionSurvivesViewRecreation() throws {
        let suite = "UnifiedConsoleControlSurfaceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults)
        #expect(preferences.expandedWorkIDs.isEmpty)
        #expect(preferences.isAssistantCollapsed)
        preferences.setWorkExpanded(true, workID: "work:a")
        preferences.setWorkExpanded(true, workID: "work:b")
        preferences.setAssistantExpanded(true)

        let restored = ConsoleOutlineExpansionPreferences(defaults: defaults)
        #expect(restored.expandedWorkIDs == ["work:a", "work:b"])
        #expect(!restored.isAssistantCollapsed)
        #expect(!restored.expandedWorkIDs.contains("work:new"))

        restored.toggleWork(workID: "work:a")
        restored.removeWork("work:b")
        restored.toggleAssistant()

        let updated = ConsoleOutlineExpansionPreferences(defaults: defaults)
        #expect(updated.expandedWorkIDs.isEmpty)
        #expect(updated.isAssistantCollapsed)
    }

    @Test
    func expandedWorkOutlineUsesIndentedChildrenInsideGroupedCards() throws {
        #expect(ConsoleWorkOutlineMetrics.childIndent == 24)
        #expect(ConsoleWorkOutlineMetrics.groupCornerRadius == 8)
        #expect(ConsoleWorkOutlineMetrics.groupHorizontalInset == 6)

        let source = try source(named: "UnifiedConsoleView.swift")
        let surface = try self.source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkDiscussionButton.swift")
        #expect(!surface.contains("Color.primary.opacity(0.065)"))
        #expect(source.contains(".padding(.leading, ConsoleWorkOutlineMetrics.childIndent)"))
        #expect(source.contains("outlineGroupEmptyRow"))
        #expect(source.contains("outlineChildSelectionBackground"))
        #expect(try sharedSource(named: "WorkActivity.swift").contains("static let disclosureAnimation = Animation.easeInOut(duration: 0.16)"))
        #expect(source.contains("struct ConsoleWorkOutlineDisclosureStyle: DisclosureGroupStyle"))
        #expect(source.contains("private typealias ConsoleWorkOutlineGroupCardModifier = WorkGroupCardSurface"))
        #expect(source.contains("return ScrollView {"))
        #expect(source.contains("LazyVStack(alignment: .leading, spacing: 8)"))
        #expect(source.contains("DisclosureGroup(isExpanded: outlineAssistantExpandedBinding)"))
        #expect(source.contains("DisclosureGroup(isExpanded: outlineWorkExpandedBinding(work.id))"))
        #expect(source.contains(".disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())"))
        #expect(surface.contains(".modifier(ConversationContentSurface(cornerRadius: 8))"))
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
        #expect(source.contains("navigationModeOption(.workOutline, title: \"分组\")"))
        #expect(!source.contains("Text(L10n(\"Work & Tasks\"))"))
        #expect(!source.contains("Text(L10n(\"Assistant\"))"))
    }

    @Test
    func workingWorkTitleUsesAnAccessibleFlowingColorGradient() throws {
        #expect(ConsoleWorkOutlineMetrics.workingGradientDuration == 2.6)

        let host = try source(named: "UnifiedConsoleView.swift")
        let source = try source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkActivity.swift")
        #expect(source.contains("public struct ConsoleWorkTitle: View"))
        #expect(source.contains("@Environment(\\.accessibilityReduceMotion)"))
        #expect(source.contains("private struct ConsoleFlowingGradientWorkTitle: View"))
        #expect(source.contains("animates: !accessibilityReduceMotion"))
        #expect(source.contains("TimelineView(.animation("))
        #expect(source.contains("WorkActivityAnimation.frameInterval"))
        #expect(source.contains("flowingTitle(progress:"))
        #expect(source.contains(".cyan, .blue, .purple, .pink, .orange, .cyan"))
        #expect(source.contains(".offset(x: proxy.size.width * (progress - 1))"))
        #expect(source.contains(".mask(Text(title))"))
        #expect(source.contains(".accessibilityLabel(title)"))
        #expect(host.contains("isWorking: processingWorkIDs.contains(work.id)"))
        #expect(host.contains("typealias ConsoleWorkTitle = CorptieConversation.ConsoleWorkTitle"))
        #expect(!source.contains("ConsoleBreathingWorkTitle"))
        #expect(!source.contains("workingPulseMinimumOpacity"))
        #expect(!source.contains("Timer.publish"))
        #expect(!source.contains("hasAdvancedGradient"))
    }

    @Test
    func workOutlineKeepsContextMenusOnTheirNativeListRows() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let outlineStart = try #require(source.range(of: "var workOutlineList: some View"))
        let outlineEnd = try #require(source.range(
            of: "func outlineChatHeader",
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
    func chatCardCreatesOnlyAssistantChat() throws {
        let console = try source(named: "UnifiedConsoleView.swift")
        #expect(console.components(
            separatedBy: "NewSessionCreationSheet(fixedKind: .assistantChat)"
        ).count - 1 >= 2)
        #expect(!console.contains("NewSessionCreationSheet()"))

        let sheet = try source(named: "NewChatPickerSheet.swift")
        #expect(sheet.contains("let fixedKind: NewSessionKind?"))
        #expect(sheet.contains("fixedKind: NewSessionKind? = nil"))
        #expect(sheet.contains("if fixedKind == nil, fixedAgent == nil, fixedWork == nil"))
        #expect(sheet.contains("fixedKind ?? .assistantChat"))
    }

    @Test
    func workChatIsAnIndependentActionBesideTheWorkTitle() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let headerStart = try #require(source.range(of: "struct ConsoleWorkOutlineHeader: View"))
        let headerEnd = try #require(source.range(
            of: "enum ConsoleTaskSelectionPolicy",
            range: headerStart.upperBound..<source.endIndex
        ))
        let header = source[headerStart.lowerBound..<headerEnd.lowerBound]

        #expect(header.contains("Button(action: toggleExpanded)"))
        let button = try self.source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkDiscussionButton.swift")
        #expect(header.contains("WorkDiscussionButton(isSelected: isChatSelected, isRunning: isChatRunning"))
        #expect(header.contains("action: openChat"))
        #expect(button.contains("Button(action: action)"))
        #expect(header.contains("Button(action: createTask)"))
        #expect(header.contains(".padding(.leading, 6)"))
        #expect(header.contains("title: L10n(\"讨论\")"))
        #expect(button.contains("bubble.left.fill"))
        #expect(button.contains(".fixedSize()"))
        #expect(button.contains("isHovering ? 0.13 : 0.07"))
        #expect(!header.contains("ellipsis.message"))
        #expect(!header.contains("bubble.left.and.bubble.right"))
        #expect(header.contains("hasUnread: hasUnreadChat"))
        #expect(button.contains("if hasUnread"))
        #expect(button.contains("isSelected ? Color.accentColor : Color.secondary"))

        #expect(!source.contains("workPendingNewChat"))
        #expect(!source.contains("NewSessionCreationSheet(fixedWork: work)"))
        #expect(source.contains("guard let workChat else { return }"))
        #expect(source.contains("openWorkChat(for: work, session: workChat)"))
        #expect(source.contains("func workChatSession(for workId: String)"))
        #expect(source.contains("indexedSession ?? backendClient.sessions.first"))
        #expect(source.contains("func openWorkChat(for work: Work, session: TaskSession)"))
    }


    @Test
    func selectedWorkUsesADiscordStyleEdgePill() throws {
        let source = try source(named: "Console/ConsoleWorkRail.swift")
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
        let source = try source(named: "Console/ConsoleSessionRows.swift")
        let rail = try self.source(named: "Console/ConsoleWorkRail.swift")
        let host = try self.source(named: "UnifiedConsoleView.swift")

        #expect(source.contains("struct WorkRailUnreadSummary: Equatable"))
        #expect(source.contains("session.resolvedSessionKind == .assistantChat"))
        #expect(source.contains("workIDs.insert(workID)"))
        #expect(source.contains("session.archived != true"))
        #expect(rail.contains("unreadSummary.hasUnreadAssistantSessions"))
        #expect(rail.contains("unreadSummary.workIDs.contains(work.id)"))
        #expect(!host.contains("ConsoleWorkRail("))
        #expect(host.contains("unifiedWorkOutlineSidebar"))
        #expect(host.contains("sessions: sessionIndexStore.rows.map(\\.session)"))
    }

    @Test
    func expandedWorkHidesItsAggregateUnreadIndicator() throws {
        let source = try source(named: "Console/ConsoleNavigationPolicies.swift")
        let headerStart = try #require(source.range(of: "struct ConsoleWorkOutlineHeader: View"))
        let headerEnd = try #require(source.range(
            of: "enum ConsoleTaskSelectionPolicy",
            range: headerStart.upperBound..<source.endIndex
        ))
        let header = source[headerStart.lowerBound..<headerEnd.lowerBound]

        #expect(header.contains("if hasUnread && !isExpanded"))
        #expect(header.contains("hasUnread: hasUnreadChat"))
        let button = try self.source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkDiscussionButton.swift")
        #expect(button.contains("if hasUnread"))
    }

    @Test
    func selectedWorkDoesNotRestyleItsAvatar() throws {
        let source = try source(named: "Console/ConsoleWorkRail.swift")
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
        let source = try source(named: "Console/ConsoleWorkRail.swift")

        #expect(source.contains("ScrollView(.vertical)"))
        #expect(source.contains(".background(ConsoleOverlayScroller(placeOnLeadingEdge: true))"))
        #expect(source.contains("private var workRailScrollMask: some View"))
        #expect(source.contains("proxy.scrollTo(selectedWorkId, anchor: .center)"))
        #expect(source.contains(".padding(.vertical, 10)"))
        #expect(!source.contains("WorkRailItemFramePreferenceKey"))
    }

    @Test
    func selectedTaskUsesACompactInsetLowRadiusBackground() throws {
        let row = try source(named: "Console/ConsoleSessionRows.swift")
        let host = try source(named: "Console/UnifiedConsoleWorkTaskList.swift")

        #expect(host.contains("ConsoleTaskRowContent("))
        #expect(row.contains("RoundedRectangle(cornerRadius: 5, style: .continuous)"))
        #expect(row.contains(".padding(.horizontal, 8)"))
        #expect(!row.contains("RoundedRectangle(cornerRadius: 10"))
    }

    @Test
    func taskRowsUseOneLineAndDoNotExposeSessionStartupAsTaskState() throws {
        let row = try source(named: "Console/ConsoleSessionRows.swift")

        #expect(row.contains("Text(task.title)"))
        #expect(row.contains(".lineLimit(1)"))
        #expect(!row.contains("L10n(\"Not started\")"))
        #expect(!row.contains("Text(session == nil"))
        #expect(!row.contains("Text(task.lifecycleState)"))
    }

    @Test
    func workChatUsesTheSameSingleLineVisualContractAsTaskRows() throws {
        let host = try source(named: "Console/UnifiedConsoleWorkTaskList.swift")
        let row = try source(named: "Console/ConsoleSessionRows.swift")

        #expect(host.contains("ConsoleWorkChatRowContent("))
        #expect(!host.contains("sessionRow(row, subtitle: L10n(\"Work discussion\"))"))
        #expect(row.contains("HStack(spacing: 9)"))
        #expect(row.contains(".frame(width: 7, height: 7)"))
        #expect(row.contains(".font(.system(size: 12, weight: .semibold))"))
        #expect(row.contains(".lineLimit(1)"))
        #expect(row.contains("RoundedRectangle(cornerRadius: 5, style: .continuous)"))
        #expect(row.contains("SessionContextMenuContent("))
    }

    @Test
    func chatSessionRowsUseTheSameCompactMetricsAsTaskRows() throws {
        let source = try source(named: "Console/ConsoleSessionRows.swift")
        let host = try self.source(named: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "struct ConsoleSessionRow: View"))
        let rowEnd = try #require(source.range(
            of: "func sessionMatchingPendingSelection(",
            range: rowStart.lowerBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(host.contains("return ConsoleSessionRow("))
        #expect(row.contains("HStack(spacing: 9)"))
        #expect(row.contains(".frame(width: 7, height: 7)"))
        #expect(row.contains(".font(.system(size: 12, weight: .semibold))"))
        #expect(row.contains(".padding(.vertical, 4)"))
        #expect(!row.contains("CompactSessionRow("))
    }

    @Test
    func taskRowsExposeUnreadStateFromTheirBoundSession() throws {
        let host = try source(named: "Console/UnifiedConsoleWorkTaskList.swift")
        let row = try source(named: "Console/ConsoleSessionRows.swift")

        #expect(host.contains("isUnread: session.map(isSessionUnread) ?? false"))
        #expect(row.contains("if isUnread"))
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

        #expect(pendingState.contains("此 Task 的聊天会话尚未就绪。"))
        #expect(!pendingState.contains(".background(.regularMaterial"))
        #expect(!pendingState.contains("RoundedRectangle(cornerRadius: 12"))
    }

    private func source(named name: String) throws -> String {
        let testsURL = URL(fileURLWithPath: #filePath)
        let packageRoot = testsURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceRoot = packageRoot.appendingPathComponent("Sources/CopetsMac")
        let primary = try String(contentsOf: sourceRoot.appendingPathComponent(name), encoding: .utf8)
        guard name == "UnifiedConsoleView.swift" else { return primary }
        let consoleRoot = sourceRoot.appendingPathComponent("Console")
        let companions = try FileManager.default.contentsOfDirectory(atPath: consoleRoot.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
            .map { try String(contentsOf: consoleRoot.appendingPathComponent($0), encoding: .utf8) }
        return ([primary] + companions).joined(separator: "\n")
    }

    private func sharedSource(named name: String) throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent(
                "../../packages/CorptieConversation/Sources/CorptieConversation/\(name)"),
            encoding: .utf8
        )
    }
}
