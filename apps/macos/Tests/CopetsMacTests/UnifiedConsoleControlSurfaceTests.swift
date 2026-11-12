import Foundation
import AppKit
import CorptieConversation
import SwiftUI
import Testing
@testable import CorptieMac

struct UnifiedConsoleControlSurfaceTests {
    @MainActor @Test
    func quickSessionTitleClicksInsideNativeOutlineAreNotLost() throws {
        struct Row: Identifiable { let id: String }
        _ = NSApplication.shared
        var selections: [String] = []
        let host = NSHostingView(rootView: ConsoleNativeOutline(groups: {
            [ConsoleNativeOutlineGroup(id: "work", header: AnyView(Text("Work")),
                rows: (0..<1000).map { Row(id: String($0)) }, isExpanded: true)]
        }) { row in
            Button { selections.append(row.id) } label: {
                Text("Session \(row.id)").frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
            }.buttonStyle(SessionSelectionPressStyle()).contextMenu { Button("Action") {} }
        })
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 240),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        func findOutline(_ view: NSView) -> NSOutlineView? {
            (view as? NSOutlineView) ?? view.subviews.lazy.compactMap(findOutline).first
        }
        let outline = try #require(findOutline(host))
        #expect(outline.acceptsFirstMouse(for: nil), "The first click must also select while activating the window")
        for rowIndex in [1, 501, 3, 1, 502] {
            outline.scrollRowToVisible(rowIndex)
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            let row = try #require(outline.view(atColumn: 0, row: rowIndex, makeIfNecessary: true))
            #expect(row.acceptsFirstMouse(for: nil), "Hosted titles must retain first-click selection after row reuse")
            let point = row.convert(.init(x: 80, y: row.bounds.midY), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try #require(NSEvent.mouseEvent(with: type, location: point,
                    modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, eventNumber: rowIndex,
                    clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
                window.sendEvent(event)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            #expect(selections.last == String(rowIndex - 1))
        }
        #expect(selections == ["0", "500", "2", "0", "501"])
    }

    @MainActor
    @Test(.serialized, arguments: [true, false])
    func sessionSelectionRunsBeforeMouseUpAndDoesNotRunAgainOnRelease(enabled: Bool) throws {
        _ = NSApplication.shared
        var selections = 0
        let host = NSHostingView(rootView: Button { selections += 1 } label: {
            Text("Session").frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
        }.buttonStyle(SessionSelectionPressStyle()).disabled(!enabled))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 40),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        host.layoutSubtreeIfNeeded()
        for click in 1...2 {
            func event(_ type: NSEvent.EventType) throws -> NSEvent {
                try #require(NSEvent.mouseEvent(with: type, location: .init(x: 150, y: 20),
                    modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, eventNumber: click,
                    clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            }
            window.sendEvent(try event(.leftMouseDown))
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            #expect(selections == (enabled ? click : 0), "Selection must happen while the mouse is still held down")
            window.sendEvent(try event(.leftMouseUp))
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            #expect(selections == (enabled ? click : 0), "Release must not trigger a second selection")
        }
    }

    @Test
    func taskDisclosureTrailsContentWithoutAddingLeadingIndentOnBothClients() throws {
        let mobileURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../ipad/Sources/PadWorkOutline.swift")
        let mobile = try String(contentsOf: mobileURL, encoding: .utf8)
        let desktop = try source(named: "Console/UnifiedConsoleWorkTaskList.swift")
        // iPad uses 44pt touch geometry and a separate pagination footer.
        for (text, rowCall, childIndent, completionLabel, collapseLabel) in [
            (desktop, "taskRow(task, showsHoverFeedback: showsHoverFeedback)", 24, "子任务完成进度", "收起子任务"),
            (mobile, "taskRow(task, sessionID: sessionID)", 44, "子任务已完成", "的子任务")
        ] {
            let start = try #require(text.range(of: "func hierarchyTaskRow("))
            let tail = String(text[start.lowerBound...])
            let content = try #require(tail.range(of: rowCall))
            let disclosure = try #require(tail.range(of: "Button {"))
            #expect(content.lowerBound < disclosure.lowerBound)
            let rowEnd = try #require(tail.range(of: "task.parentTaskId == nil ? 0 : \(childIndent)"))
            let row = String(tail[..<rowEnd.upperBound])
            #expect(!row.contains("Color.clear"))
            #expect(text.contains("加载更多子任务"))
            #expect(row.contains(collapseLabel))
            #expect(row.contains(completionLabel))
        }
    }

    @Test
    func primaryWorkOutlineUsesTheSameCollapsibleTaskRowsAsTaskSidebar() throws {
        let outline = try source(named: "Console/UnifiedConsoleOutline.swift")
        let rows = try source(named: "Console/UnifiedConsoleWorkTaskList.swift")
        #expect(outline.contains("let workRows = workRowsByWorkID[work.id] ?? .empty"))
        #expect(outline.contains("ForEach(visibleTasks)"))
        #expect(outline.contains("hierarchyTaskRow(task, showsHoverFeedback: false)"))
        #expect(outline.contains("ForEach(orderedTasks)"))
        // Limit root groups, not flattened rows: expanding a parent must never
        // truncate its children at the Work's initial Task limit.
        #expect(outline.contains("totalCount: workRows.rootCount"))
        #expect(outline.contains("workRows.rows(showsAll:"))
        #expect(!outline.contains("ForEach(tasks.prefix(visibleTaskCount))"))
        #expect(rows.contains("func hierarchyTaskRow(_ task: CorptieTask, showsHoverFeedback: Bool = true)"))
        #expect(rows.contains("task.parentTaskId == nil ? 0 : 24"))
        #expect(rows.contains("收起子任务"))
    }

    @Test
    func cardGroupsUpdateAutomaticallyWithoutManualRefreshAndUseNativeTaskGrid() throws {
        let console = try source(named: "UnifiedConsoleView.swift")
        let workspace = try source(named: "ConsoleCardWorkspace.swift")
        #expect(!console.contains("cardRefreshRevision"))
        #expect(!console.contains("刷新重点 Task"))
        #expect(!workspace.contains("refreshRevision"))
        #expect(!workspace.contains("rebuild(reset:"))
        #expect(workspace.contains(".onChange(of: WorkCanvasDataRebuildInput("))
        #expect(workspace.contains("if previous.active && next.active { rebuild() }"))
        #expect(workspace.contains("WorkTaskCardGrid(itemCount: roots.count, availableWidth: availableWidth)"))
        #expect(workspace.contains("ForEach(roots)"))
        #expect(workspace.contains("groupInteraction(for: work.id, availableWidth: availableWidth)"))
        #expect(!workspace.contains("ContentSizedTaskCardLayout { card(task) }"))
    }

    @MainActor
    @Test
    func workHeaderBlankAreaClicksOnlyToggleDisclosure() throws {
        _ = NSApplication.shared
        var toggles = 0
        var taskCreates = 0
        let work = Work(id: "work:hit-test", workspaceId: "workspace:test", name: "Work",
            description: "", status: "active", profile: "general", tags: [], contributorRoleIds: [],
            createdAt: "", updatedAt: "")
        let host = NSHostingView(rootView: ConsoleWorkOutlineHeader(work: work,
            isExpanded: false, isSelected: false, isWorking: false, hasUnread: false,
            toggleExpanded: { toggles += 1 },
            createTask: { taskCreates += 1 }))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 28),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
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
        #expect(taskCreates == 0)
    }

    @Test
    func workHeaderUsesSharedPriorityAndNonLayoutBlankHitAreaOnBothClients() throws {
        let desktop = try source(named: "Console/ConsoleNavigationPolicies.swift")
        let headerStart = try #require(desktop.range(of: "struct ConsoleWorkOutlineHeader: View"))
        let headerEnd = try #require(desktop.range(of: "enum ConsoleTaskSelectionPolicy", range: headerStart.upperBound..<desktop.endIndex))
        let header = String(desktop[headerStart.lowerBound..<headerEnd.lowerBound])
        #expect(header.components(separatedBy: "Button(action: toggleExpanded)").count == 2)
        #expect(header.contains("WorkOutlineHeaderRow(toggleExpanded: toggleExpanded)"))
        #expect(!header.contains("work-header-empty-"))
        #expect(header.contains(".opacity(isHovering || isCreateTaskFocused ? 1 : 0.45)"))
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
        #expect(mobile.contains("WorkOutlineHeaderRow(minimumHeight: 44, toggleExpanded: toggle)"))
        #expect(!mobile.contains("work-header-empty-"))
        #expect(mobile.contains("ViewThatFits(in: .horizontal)"))
        #expect(mobile.contains("minimumHitHeight: 44"))
        #expect(mobile.contains(".lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)"))
        let shared = try sharedSource(named: "WorkOutlineHeaderRow.swift")
        #expect(shared.contains("title.layoutPriority(1)"))
        #expect(shared.contains("Spacer(minLength: 4).layoutPriority(-1)"))
        #expect(shared.contains(".background {"))
        #expect(shared.contains(".accessibilityHidden(true)"))
        #expect(!shared.contains("GeometryReader"))
        #expect(!shared.contains(".onTapGesture"))
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
            #expect(contents.contains(".read(scope: scope)"))
            #expect(contents.contains("try await Task.sleep(for: .milliseconds(600))"))
            #expect(contents.contains("ClientQuickMessageDiagnostics.failure(error)"))
        }
        let api = try source(named: "Backend/BackendClientInteractions.swift")
        #expect(api.contains("return try result.validated()"))
        #expect(!api.contains("items.count <= 6"))
    }

    @Test
    func experimentalDetailsRemainOpenWithoutToggleState() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        #expect(!source.contains("showsCardTaskDetails"))
        #expect(!source.contains("显示或隐藏 Task Info"))
        #expect(source.contains("SessionDetailPanel(session: session, railWidth: ConversationDetailWidgetMetrics.railWidth,"))
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
        #expect(MainWindowPageLayoutMetrics.cardBorderOpacity == 0.10)
        #expect(MainWindowPageLayoutMetrics.cardBorderWidth == 0.5)

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
    func navigationControlsUseTopRowWithoutTrafficLightClearance() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let controlsStart = try #require(source.range(of: ".safeAreaInset(edge: .top, spacing: 0) {"))
        let controlsEnd = try #require(source.range(of: "var navigationMode:", range: controlsStart.upperBound..<source.endIndex))
        let controls = source[controlsStart.lowerBound..<controlsEnd.lowerBound]

        let togglePosition = try #require(controls.range(of: "navigationModeToggle"))
        let searchPosition = try #require(controls.range(of: "searchToggleButton"))
        let sortPosition = try #require(controls.range(of: "outlineSortMenu"))
        let archivePosition = try #require(controls.range(of: "taskArchiveToggle"))
        #expect(sortPosition.lowerBound < togglePosition.lowerBound)
        #expect(searchPosition.lowerBound < sortPosition.lowerBound)
        #expect(togglePosition.lowerBound < archivePosition.lowerBound)
        // Search / More own this row alone. The Create control has its own
        // layout in the Work column; putting it back here would make the two
        // panes' top rows different heights again.
        #expect(!controls.contains("outlineCreationMenu"))
        #expect(source.contains("consoleSidebarCreationRow"))
        #expect(controls.contains(".frame(height: MainWindowPageLayoutMetrics.headerRowHeight, alignment: .top)"))
        #expect(MainWindowPageLayoutMetrics.headerRowHeight == 48)
        #expect(source.contains("Menu(\"视图\") {\n            navigationModeOption(.workOutline, title: \"分组\")"))
        #expect(source.contains("Picker(\"排序方式\", selection:"))
        #expect(!source.contains("Menu(\"排序方式\")"))
        let menuStart = try #require(source.range(of: "var outlineSortMenu:"))
        let menuEnd = try #require(source.range(of: "var cardWorkspaceSidebar:", range: menuStart.upperBound..<source.endIndex))
        let menuContent = source[menuStart.lowerBound..<menuEnd.lowerBound]
        #expect(!menuContent.contains("PlatformWorkOutlineToolbarGlyph"))
        #expect(!menuContent.contains("platformWorkOutlineToolbarControl"))
        #expect(source.contains(".modifier(ConsoleTopEdgeEffectModifier())"))
        #expect(controls.contains(".platformWorkOutlineToolbarDensity(.titlebar)"))
        #expect(controls.contains(".padding(.top, 2)"))
        #expect(!controls.contains("MainWindowLayoutMetrics.titlebarHeight + 10"))
        #expect(!controls.contains(".padding(.top, 3)"))
        #expect(PlatformWorkOutlineLayout.controlSize == 44)
        #expect(PlatformWorkOutlineLayout.controlSurfaceDiameter == 36)
        #expect(PlatformWorkOutlineLayout.symbolSize == 16)
        #expect(PlatformWorkOutlineLayout.toolbarHeight == 56)
        #expect(PlatformWorkOutlineLayout.minimumToolbarWidth == 276)
        #expect(PlatformWorkOutlineLayout.columnWidth == 312)
        #expect(PlatformWorkOutlineToolbarDensity.compact.controlSize == 36)
        #expect(PlatformWorkOutlineToolbarDensity.compact.controlSurfaceDiameter == 30)
        #expect(PlatformWorkOutlineToolbarDensity.compact.symbolSize == 14)
        #expect(!source.contains("ConsoleSidebarTitlebarControls("))
        let mobile = try self.source(named: "../../../../apps/ipad/Sources/PadWorkOutline.swift")
        #expect(mobile.contains("PlatformWorkOutlineToolbar("))
        #expect(mobile.contains(".platformWorkOutlineToolbarControl()"))
        #expect(source.contains(".platformWorkOutlineToolbarControl()"))
    }

    @Test
    func conversationHeaderAccessorySharesTheTopRowHeight() throws {
        let split = try source(named: "ConsoleWindowSplitView.swift")
        #expect(split.contains(
            "accessoryHeight: Header.self == EmptyView.self ? 0 : MainWindowPageLayoutMetrics.headerRowHeight"))
        // 72pt pinned a ~45pt header, leaving ~27pt of dead space below it.
        #expect(!split.contains("EmptyView.self ? 0 : 72"))
        #expect(MainWindowPageLayoutMetrics.headerRowHeight < 56)
    }

    @Test @MainActor
    func workToolbarFitsNarrowSidebarWithoutShrinkingButtons() {
        let host = NSHostingView(rootView: PlatformWorkOutlineToolbar {
            ForEach(["arrow.up.arrow.down", "rectangle.3.group", "magnifyingglass", "archivebox"], id: \.self) { symbol in
                Button {} label: { PlatformWorkOutlineToolbarGlyph(symbol: symbol) }
                    .platformWorkOutlineToolbarControl()
            }
        } trailing: {
            Menu {} label: { PlatformWorkOutlineToolbarGlyph(symbol: "plus") }
                .platformWorkOutlineToolbarControl()
                .menuIndicator(.hidden)
        })
        for width in [276.0, 312.0, 420.0] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: PlatformWorkOutlineLayout.toolbarHeight)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height == PlatformWorkOutlineLayout.toolbarHeight)
            #expect(host.fittingSize.width <= width)
        }
    }

    @Test @MainActor
    func flatWorkToolbarAlignsWithNativeTrafficLightsAtEverySidebarWidth() throws {
        let marker = NSView()
        let host = NSHostingView(rootView: VStack(spacing: 0) {
            PlatformWorkOutlineToolbar(density: .titlebar) {
                ForEach(["arrow.up.arrow.down", "rectangle.3.group", "magnifyingglass", "archivebox"], id: \.self) { symbol in
                    Button {} label: { PlatformWorkOutlineToolbarGlyph(symbol: symbol) }
                        .platformWorkOutlineToolbarControl()
                }
            } trailing: {
                Menu {} label: { PlatformWorkOutlineToolbarGlyph(symbol: "plus") }
                    .platformWorkOutlineToolbarControl()
                    .menuIndicator(.hidden)
            }
            .background(WorkToolbarFrameProbe(view: marker))
            Spacer(minLength: 0)
        }.ignoresSafeArea(.container, edges: .top))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.contentView = host
        defer { window.close() }
        let close = try #require(window.standardWindowButton(.closeButton))
        for width in [220.0, 312.0, 420.0] {
            window.setContentSize(NSSize(width: width, height: 300))
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            let toolbarFrame = marker.convert(marker.bounds, to: nil)
            let closeFrame = close.convert(close.bounds, to: nil)
            #expect(abs(toolbarFrame.midY - closeFrame.midY) < 0.5)
            #expect(toolbarFrame.height == 32)
            #expect(toolbarFrame.width <= width)
            func hasBackdrop(_ layer: CALayer) -> Bool {
                String(describing: type(of: layer)).contains("BackdropLayer")
                    || (layer.sublayers ?? []).contains(where: hasBackdrop)
            }
            if let layer = host.layer { #expect(!hasBackdrop(layer)) }
        }
    }

    @Test @MainActor
    func compactMacWorkToolbarFitsFiveControlsWithoutChangingIPadSizing() {
        let density = PlatformWorkOutlineToolbarDensity.compact
        let host = NSHostingView(rootView: PlatformWorkOutlineToolbar(density: density) {
            ForEach(["arrow.up.arrow.down", "rectangle.3.group", "magnifyingglass", "archivebox"], id: \.self) { symbol in
                Button {} label: { PlatformWorkOutlineToolbarGlyph(symbol: symbol) }
                    .platformWorkOutlineToolbarControl()
            }
        } trailing: {
            Menu {} label: { PlatformWorkOutlineToolbarGlyph(symbol: "plus") }
                .platformWorkOutlineToolbarControl()
                .menuIndicator(.hidden)
        })
        let expectedHeight = density.controlSize + density.verticalInset * 2
        for width in [220.0, 312.0, 420.0] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: expectedHeight)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height == expectedHeight)
            #expect(host.fittingSize.width <= width)
        }
        #expect(PlatformWorkOutlineToolbarDensity.regular.controlSize == 44)
    }

    @Test
    func workOutlineUsesNativeSidebarScrollerPlacement() throws {
        let source = try source(named: "Console/UnifiedConsoleOutline.swift")
        #expect(source.contains(".listStyle(.sidebar)"))
        #expect(!source.contains(".background(ConsoleOverlayScroller())"))
        #expect(!source.contains("ConsoleOverlayScroller(placeOnLeadingEdge: true)"))
        #expect(!source.contains(".contentMargins(.leading"))
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
        #expect(composer.contains("ComposerEditorRowLayout(minimumEditorWidth: 100)"))
        #expect(composer.contains("ThreadMetaView("))
        #expect(composer.contains("|| sendingMessage"))
        #expect(composer.contains("!sendingMessage else"))
        #expect(!composer.contains(".opacity(!backendClient.selectedCanSendNow"))
        #expect(!composer.contains(".disabled(!isReady)"))
    }

    @Test
    func jumpToLatestFloatsInFixedSlotAboveChecklistInBaseLiquidGlass() throws {
        let conversation = try source(named: "Conversation/SessionConversationContent.swift")
        let composer = try source(named: "Conversation/Composer/MessageComposer.swift")
        let styles = try source(named: "Floating/Chrome/ConversationButtonStyles.swift")
        #expect(conversation.contains("onJumpToLatest: composerJumpToLatestAction"))
        #expect(conversation.contains("if !usesComposerJumpToLatest"))
        #expect(!conversation.contains("composerClearance + 8"))
        #expect(composer.contains("VStack(alignment: .leading, spacing: 4)"))
        #expect(composer.contains("HStack(spacing: 8)"))
        #expect(composer.contains("quickMessagePresentation == nil"))
        #expect(composer.contains("struct ComposerQuickMessagesBar: View"))
        #expect(composer.contains("Button(action: onJumpToLatest)"))
        #expect(composer.contains("JumpToLatestButtonStyle(highlightsUnread: hasUnreadMessagesBelow)"))
        #expect(conversation.contains("bottomClearance: 0"))
        #expect(conversation.contains("ConversationRegionStack(floating: AnyView(floatingDock))"))
        #expect(!conversation.contains(".onPreferenceChange(ConversationChromeFramePreferenceKey.self)"))
        #expect(!conversation.contains("conversationChromeFrame(.composer)"))
        #expect(conversation.contains("ConversationComposerDock"))
        #expect(!conversation.contains("quickMessageClearance"))
        #expect(conversation.contains("quickMessagePresentation: quickMessagePresentation"))
        #expect(conversation.contains("appKitScrollToBottomRevision &+= 1"))

        // The control owns a fixed slot ABOVE the pinned checklist, not a row
        // between the checklist and the quick messages.
        #expect(conversation.contains("if usesJumpControlSlot { jumpControlSlot }"))
        #expect(conversation.contains(".frame(height: ComposerQuickMessagesBar.jumpControlSize)"))
        #expect(conversation.contains("onJumpToLatest: nil"))
        let slot = try #require(conversation.range(of: "if usesJumpControlSlot { jumpControlSlot }"))
        let checklist = try #require(conversation.range(of: "PinnedExecutionChecklistCard(plan: plan)"))
        #expect(slot.lowerBound < checklist.lowerBound,
            "The jump slot must render before the checklist card")
        // Centred, touching the checklist, floating over the transcript.
        #expect(composer.contains("VStack(spacing: 0)"))
        #expect(conversation.contains(".frame(maxWidth: .infinity, alignment: .center)"))
        #expect(composer.contains("static let jumpControlSize: CGFloat = 30"))
        #expect(conversation.contains("ComposerQuickMessagesBar.jumpControlSize"))
        // Untinted system liquid glass only: no opaque plate, stroke or brand fill.
        #expect(styles.contains(".platformGlassSurface(in: Circle(), interactive: true)"))
        #expect(!styles.contains("CorptiePalette.connected"))
        #expect(!styles.contains(".background(background, in: Circle())"))
        #expect(!styles.contains("strokeBorder(border"))
        #expect(!styles.contains(".tint("))
    }

    @Test
    func jumpControlVisibilityNeverChangesDockHeightOrTranscriptInset() throws {
        let conversation = try source(named: "Conversation/SessionConversationContent.swift")
        // Neither the dock overlap nor the timeline's bottom clearance may
        // depend on whether the button is currently visible.
        #expect(!conversation.contains("let jumpControlHeight"))
        #expect(!conversation.contains("quickMessagePresentation.showsMessages || composerJumpToLatestAction"))
        #expect(conversation.contains("private var usesJumpControlSlot"))
        #expect(conversation.contains("private var floatingDock: some View"))
        #expect(!conversation.contains("private var quickMessageOverlap"))
        #expect(conversation.contains("ConversationRegionStack(floating: AnyView(floatingDock))"))
        #expect(conversation.contains("bottomClearance: 0"))
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

        #expect(createSource.contains("|| contributorRoleIds.isEmpty"))
        #expect(createSource.contains("guard EntityNamePolicy.isValid(name), !contributorRoleIds.isEmpty"))
        #expect(createSource.contains("请至少选择一个 Contributor 角色"))
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
    func memoryHitUsesTheSharedFullRowDisclosure() throws {
        let source = try source(named: "MemoryManagementView.swift")
        #expect(source.contains("ConversationDetailDisclosure(isExpanded: $isExpanded"))
        #expect(source.contains("Label(L10n(\"Memory Hit\")"))
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
        #expect(fields.contains("(\"Role\", agentDisplayName)"))
        #expect(fields.contains("(\"工作空间\", compactPath(cwd))"))
        #expect(!fields.contains("currentModel"))
        #expect(!fields.contains("currentReasoningLevel"))
        #expect(!fields.contains("推理强度"))
    }


    @Test
    func navigationRemovesClassicAndMigratesItsSavedPreference() throws {
        #expect(ConsoleNavigationMode.allCases == [.workOutline, .sessionList, .taskCards])
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
        #expect(source.contains("outlineExpansionPreferences.isWorkExpanded"))
        #expect(source.contains("workChatRow(row)"))
        #expect(source.contains("hierarchyTaskRow(task"))
        #expect(!source.contains("navigationModeOption(.workRail"))
        #expect(source.contains("navigationModeOption(.workOutline, title: \"分组\")"))
        #expect(source.contains("navigationModeOption(.taskCards, title: \"卡片 · 实验\")"))
        #expect(source.contains(".menuStyle(.borderlessButton)"))
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
    func workOutlineUsesNativeSidebarDisclosureWithoutCustomAnimationLayout() throws {
        let source = try source(named: "UnifiedConsoleView.swift")
        let surface = try self.source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkDiscussionButton.swift")
        #expect(!surface.contains("Color.primary.opacity(0.065)"))
        #expect(surface.contains(".modifier(ConversationContentSurface(cornerRadius: 8, isPanel: true, role: .project))"))
        #expect(source.contains("outlineGroupEmptyRow"))
        #expect(source.contains(".consoleOutlineRowSurface(isSelected:"))
        #expect(source.contains("horizontalInset: 8"))
        #expect(source.contains(".padding(.trailing, 16)"))
        #expect(source.contains("hierarchyTaskRow(task, showsHoverFeedback: false)"))
        #expect(!source.contains("outlineChildSelectionBackground"))
        #expect(source.contains("ConsoleNativeOutline(groups: { nativeOutlineGroups })"))
        #expect(source.contains("outline.animator()"))
        #expect(source.contains("target.expandItem(node)"))
        #expect(source.contains("target.collapseItem(node)"))
        #expect(!source.contains("ConsoleWorkOutlineDisclosureStyle"))
        #expect(!source.contains("ConsoleDisclosureRevealLayout"))
        #expect(!source.contains("ConsoleWorkOutlineRows"))
        #expect(!source.contains("consoleWorkOutlineGroupCard"))
        #expect(source.contains("outlineFullyExpandedWorkIDs.remove(workID)"))
    }

    @Test
    func activeWorkGroupsLimitTasksUntilExplicitRevealOnBothClients() throws {
        let desktop = try source(named: "UnifiedConsoleView.swift")
        #expect(desktop.contains("WorkOutlineTaskDisclosurePolicy.visibleCount("))
        #expect(desktop.contains("workRows.rows(showsAll: showsAll || queryIsActive)"))
        #expect(desktop.contains("totalCount: workRows.rootCount"))
        #expect(desktop.contains("outlineShowAllTasksButton("))
        #expect(desktop.contains("outlineFullyExpandedWorkIDs.remove(workID)"))
        #expect(desktop.contains("accessibilityLabel(\"展开全部 Task，还剩 \\(hiddenCount) 个\")"))

        let mobile = try source(named: "../../../ipad/Sources/PadWorkOutline.swift")
        #expect(mobile.contains("WorkOutlineTaskDisclosurePolicy.visibleCount("))
        #expect(mobile.contains("ForEach(visibleTasks)"))
        #expect(mobile.contains("totalCount: roots.count"))
        #expect(mobile.contains("visibleRootIDs.contains($0.parentTaskId ?? $0.id)"))
        #expect(mobile.contains(".padding(.leading, task.parentTaskId == nil ? 0 :"))
        #expect(mobile.contains("showAllTasksButton(workID:"))
        #expect(mobile.contains("fullyExpandedWorkIDs.remove(id)"))
        #expect(mobile.contains("accessibilityLabel(\"展开全部 Task，还剩 \\(hiddenCount) 个\")"))
    }

    @Test
    func workingWorkTitleFlowsThroughCALayerWithoutASwiftUIAnimation() throws {
        #expect(ConsoleWorkOutlineMetrics.workingGradientDuration == 2.6)

        let host = try source(named: "UnifiedConsoleView.swift")
        let source = try source(named: "../../../../packages/CorptieConversation/Sources/CorptieConversation/WorkActivity.swift")
        #expect(source.contains("public struct ConsoleWorkTitle: View"))
        #expect(source.contains("@Environment(\\.accessibilityReduceMotion)"))
        #expect(source.contains("private struct ConsoleFlowingGradientWorkTitle: View"))
        #expect(source.contains("animates: !accessibilityReduceMotion"))
        // The flow must be compositor-side. A SwiftUI repeating animation never
        // stops and re-layouts the whole window on every display cycle.
        #expect(!source.contains("repeatForever"))
        #expect(!source.contains("flowingTitle(progress:"))
        #expect(!source.contains("Timer.publish"))
        #expect(!source.contains("hasAdvancedGradient"))
        #expect(!source.contains("ConsoleBreathingWorkTitle"))
        #expect(!source.contains("workingPulseMinimumOpacity"))
        #expect(source.contains(".cyan, .blue, .purple, .pink, .orange"))
        #expect(source.contains(".accessibilityLabel(title)"))
        // Reduce Motion / inactive pages keep the calm colour-only treatment.
        #expect(source.contains(".foregroundStyle(staticGradient)"))
        #expect(source.contains("WorkTitleFlowLayer(title: title, fontSize: fontSize, weight: weight)"))
        #expect(source.contains("CABasicAnimation(keyPath: \"transform.translation.x\")"))
        #expect(source.contains("flow.repeatCount = .infinity"))
        #expect(source.contains("gradient.removeAnimation(forKey: Key.flow)"))
        #expect(source.contains("masked.speed = 0"))
        #expect(host.contains("isWorking: processingWorkIDs.contains(work.id)"))
        #expect(host.contains("typealias ConsoleWorkTitle = CorptieConversation.ConsoleWorkTitle"))
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

        #expect(outline.contains("hierarchyTaskRow(task, showsHoverFeedback: false)"))
        let taskRows = try self.source(named: "Console/UnifiedConsoleWorkTaskList.swift")
        #expect(taskRows.contains("taskRow(task, showsHoverFeedback: showsHoverFeedback)"))
        #expect(!outline.contains("workChatRow(row)"))
        #expect(!outline.contains("Start Work Chat"))
        #expect(outline.contains("sessionRow(row, showsHoverFeedback: false)"))
        #expect(outline.contains("workContextMenuContent(for: work)"))
        #expect(!source.contains("workOutlineContextMenu(for work: Work)"))
        #expect(!source.contains("ConsoleWorkOutlineContextTarget"))
        #expect(!source.contains("ConsoleRightClickMenuHitTarget"))
        #expect(outline.contains("ConsoleNativeOutline(groups:"))
        #expect(outline.contains("nativeOutlineGroups"))
        #expect(outline.contains("expansionChanged:"))
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

private struct WorkToolbarFrameProbe: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
