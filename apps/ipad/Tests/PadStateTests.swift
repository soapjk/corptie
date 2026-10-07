import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadStateTests {
    @Test func compactWorkspacePagesExposeTheSingleRootWallpaper() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let app = try String(contentsOf: sources.appendingPathComponent("CorptieMobileApp.swift"), encoding: .utf8)
        let compact = app.components(separatedBy: "private func compactWorkspace(")[1]
            .components(separatedBy: "private func openCompactSession(")[0]
        #expect(compact.components(separatedBy: ".padWorkspaceNavigationBackground()").count - 1 == 3)
        #expect(!app.contains("LocalWallpaperCanvas("))
        let shell = try String(contentsOf: sources.appendingPathComponent("PadAppShell.swift"), encoding: .utf8)
        #expect(shell.components(separatedBy: "LocalWallpaperCanvas(").count - 1 == 1)
        let helper = try String(contentsOf: sources.appendingPathComponent("PadGlassSurface.swift"), encoding: .utf8)
        #expect(helper.contains("containerBackground(.clear, for: .navigation)"))
        #expect(!helper.contains("PadLegacyNavigationBackground"))
        #expect(!helper.contains("#available(iOS"))
        #expect(!helper.contains(".appearance()"))
        #expect(!helper.contains("LocalWallpaperCanvas("))
    }

    @Test func emptyComposerIgnoresStaleExpandedMeasurements() {
        #expect(PadComposerHeightPolicy.height(text: "", measured: 96, isPhone: true) == 36)
        #expect(PadComposerHeightPolicy.height(text: "", measured: 96, isPhone: false) == 30)
        #expect(PadComposerHeightPolicy.height(text: "new draft", measured: 60, isPhone: true) == 60)
        #expect(PadComposerHeightPolicy.height(text: "a\nb\nc", measured: 140, isPhone: false) == 96)
    }

    @Test func gesturesAndComposerHeightUseIndependentLifecycleUpdates() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let app = try String(contentsOf: sources.appendingPathComponent("CorptieMobileApp.swift"), encoding: .utf8)
        let gesture = app.components(separatedBy: "private struct CompactConversationPan:")[1]
            .components(separatedBy: "private struct CompactBackSwipe:")[0]
        #expect(!gesture.contains("TimelineScrollViewResolver"))
        #expect(!gesture.contains("resolutionAttempts"))
        #expect(gesture.contains("override func layoutSubviews()"))
        #expect(gesture.contains("override func didMoveToWindow()"))
        #expect(gesture.contains("coordinator.detach()"))
        #expect(gesture.contains("region.bounds.contains(touch.location(in: region))"))
        #expect(gesture.contains("text.isEditable || text.selectedRange.length > 0"))
        let editor = try String(contentsOf: sources.appendingPathComponent("PadComposerTextView.swift"), encoding: .utf8)
        #expect(editor.contains("guard !heightReportScheduled"))
        #expect(editor.contains("DispatchQueue.main.async { [weak self]"))
        #expect(editor.contains("self.deliverHeight()"))
        let composer = try String(contentsOf: sources.appendingPathComponent("PadComposer.swift"), encoding: .utf8)
        #expect(composer.contains("PadComposerHeightPolicy.height("))
    }

    @Test func timelineWidthReservesBothMarginsBeforeAnyMessageAppears() {
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: 393) == 361)
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: 393.75) == 361)
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: 768) == 736)
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: 0) == 0)
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: 20) == 0)
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: .nan) == 0)
        #expect(PadTimelineLayoutMetrics.laneWidth(viewportWidth: .infinity) == 0)
    }

    @Test func timelineMarginsAreOwnedByScrollViewNotLazyTargetPadding() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/CorptieMobileApp.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        let timeline = source.components(separatedBy: "struct ConversationView: View")[1]
            .components(separatedBy: "private var timelineCoordinateSpace")[0]
        #expect(timeline.contains("ScrollView(.vertical)"))
        #expect(timeline.contains(".frame(width: cardLaneWidth)"))
        #expect(timeline.contains(".contentMargins(.horizontal, PadTimelineLayoutMetrics.horizontalMargin, for: .scrollContent)"))
        #expect(!timeline.contains(".padding(.horizontal, 16)"))
        #expect(!source.contains("ScrollPosition(edge: .bottom)"))
    }
    @Test func initialPlacementRequiresVisibleTailAsWellAsEstimatedBottom() {
        #expect(!PadTimelineJumpPolicy.placementConfirmed(tailVisible: false, nearBottom: true))
        #expect(!PadTimelineJumpPolicy.placementConfirmed(tailVisible: true, nearBottom: false))
        #expect(PadTimelineJumpPolicy.placementConfirmed(tailVisible: true, nearBottom: true))
        #expect(PadTimelineJumpPolicy.correctionDelays.count == 4)
        #expect(PadTimelineJumpPolicy.correctionDelays.reduce(0, +) < 1_000)
    }

    @Test func lazyTimelineHasStableRowsAndNativeScrollingWithoutBlindCompletion() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/CorptieMobileApp.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        let rows = source.components(separatedBy: "ForEach(workspace.displayEntries) { entry in")[1]
            .components(separatedBy: "Color.clear.frame(height: 1).id(\"latest\")")[0]
        #expect(rows.contains("VStack(spacing: 0)"))
        #expect(rows.contains(".id(entry.id)"))
        #expect(!rows.contains(".id(message.id)"))
        #expect(source.contains("position.scrollTo(edge: .bottom)"))
        #expect(source.contains(".scrollTargetLayout()"))
        let automatic = source.components(separatedBy: "private func scheduleLatestPlacement")[1]
            .components(separatedBy: "private func requestSemanticTailScroll")[0]
        #expect(automatic.contains("didPlaceInitialTimeline = isPlacementConfirmed()"))
        #expect(!automatic.contains("milliseconds(16)"))
        let resolver = source.components(separatedBy: "private func findScrollView() -> UIScrollView?")[1]
        #expect(resolver.contains("!(scrollView is UITextView)"))
        #expect(resolver.contains("widthMatches && heightMatches"))
    }
    @Test func conversationSwipeNavigatesFromAnyStartPositionButNotVerticalOrOwnedContent() {
        #expect(PadConversationSwipePolicy.destination(horizontal: 100, vertical: 8) == .taskList)
        #expect(PadConversationSwipePolicy.destination(horizontal: -100, vertical: 8) == .detail)
        #expect(PadConversationSwipePolicy.destination(horizontal: -30, vertical: 0) == nil)
        #expect(PadConversationSwipePolicy.destination(horizontal: -90, vertical: 90) == nil)
        #expect(PadConversationSwipePolicy.destination(horizontal: 0, vertical: 160) == nil)
        #expect(PadConversationSwipePolicy.destination(horizontal: -100, vertical: 0, contentOwnsGesture: true) == nil)
        #expect(!PadConversationSwipePolicy.isHorizontal(x: 10, y: 100))
        #expect(!PadConversationSwipePolicy.isHorizontal(x: .nan, y: 0))
    }
    @Test func workReturnSwipeRequiresAnIntentionalLeftwardMovement() {
        #expect(PadWorkReturnSwipePolicy.opensPreviousTask(horizontal: -90, vertical: 8))
        #expect(!PadWorkReturnSwipePolicy.opensPreviousTask(horizontal: 90, vertical: 8))
        #expect(!PadWorkReturnSwipePolicy.opensPreviousTask(horizontal: -20, vertical: 0))
        #expect(!PadWorkReturnSwipePolicy.opensPreviousTask(horizontal: -90, vertical: 90))
        #expect(!PadWorkReturnSwipePolicy.opensPreviousTask(horizontal: 2, vertical: 160))
    }

    @Test func previousMobileTaskTracksLastOpenedTaskAndItsCurrentBinding() throws {
        let connection = PadConnection()
        connection.serverID = "server"
        let workspace = PadWorkspace()
        func task(_ id: String, _ sessionID: String) throws -> ClientTask {
            let data = try JSONSerialization.data(withJSONObject: ["id": id, "title": id,
                "workId": "work", "lifecycleState": "active", "executionStatus": "idle",
                "currentSessionId": sessionID, "updatedAt": "now"])
            return try JSONDecoder().decode(ClientTask.self, from: data)
        }
        workspace.tasks = [try task("first", "session:first"), try task("second", "session:second")]
        for id in ["session:first", "session:second", "session:rebound"] {
            let data = try JSONSerialization.data(withJSONObject: ["id": id, "title": id,
                "executionStatus": "idle", "updatedAt": "now"])
            workspace.sessionsByID[id] = try JSONDecoder().decode(ClientSession.self, from: data)
        }
        #expect(workspace.previousMobileTaskSession(connection) == nil)
        workspace.rememberOpenedMobileTask(connection, sessionID: "session:first")
        #expect(workspace.previousMobileTaskSession(connection) == "session:first")
        workspace.rememberOpenedMobileTask(connection, sessionID: "discussion")
        #expect(workspace.previousMobileTaskSession(connection) == "session:first")
        workspace.rememberOpenedMobileTask(connection, sessionID: "session:second")
        #expect(workspace.previousMobileTaskSession(connection) == "session:second")
        workspace.tasks[1] = try task("second", "session:rebound")
        #expect(workspace.previousMobileTaskSession(connection) == "session:rebound")
        workspace.sessionsByID.removeValue(forKey: "session:rebound")
        #expect(workspace.previousMobileTaskSession(connection) == nil)
        connection.serverID = "other"
        #expect(workspace.previousMobileTaskSession(connection) == nil)
        connection.serverID = "server"
        workspace.tasks.removeLast()
        #expect(workspace.previousMobileTaskSession(connection) == nil)
    }
    @Test func savedPairingDoesNotMakeInterruptedTransportLookConnected() {
        #expect(PadServerConnectionStatus.resolve(hasPairing: true,
            realtimeConnected: false, reconnectFailed: false) == .connecting)
        #expect(PadServerConnectionStatus.resolve(hasPairing: true,
            realtimeConnected: false, hasInterrupted: true) == .streamInterrupted)
        #expect(PadServerConnectionStatus.resolve(hasPairing: true,
            realtimeConnected: false, reconnectFailed: true) == .streamInterrupted)
        #expect(PadServerConnectionStatus.resolve(hasPairing: true,
            realtimeConnected: true, reconnectFailed: true) == .connected)
        #expect(PadServerConnectionStatus.resolve(hasPairing: false,
            realtimeConnected: true, reconnectFailed: false) == .disconnected)
        #expect(PadServerConnectionStatus.disconnected.title == "现在已经断开连接")
        #expect(PadServerConnectionStatus.streamInterrupted.title == "实时消息暂时中断，正在重连")
    }

    @Test func foregroundRecoveryClearsBackgroundFailureAndInvalidatesOldStream() {
        let workspace = PadWorkspace()
        let oldGeneration = UUID()
        workspace.realtimeGeneration = oldGeneration
        workspace.realtimeReconnectFailed = true
        workspace.realtimePausedAt = Date()
        workspace.prepareForegroundRealtime()
        #expect(!workspace.realtimeReconnectFailed)
        #expect(!workspace.realtimeConnected)
        #expect(workspace.realtimePausedAt == nil)
        #expect(workspace.realtimeGeneration != oldGeneration)
    }

    @Test func latestJumpRequiresBothRealizedTailAndPhysicalBottom() {
        #expect(!PadTimelineJumpPolicy.isAtLatest(tailMinY: nil, viewportHeight: 600, distanceToBottom: 0))
        #expect(!PadTimelineJumpPolicy.isAtLatest(tailMinY: 900, viewportHeight: 600, distanceToBottom: 0))
        #expect(!PadTimelineJumpPolicy.isAtLatest(tailMinY: 580, viewportHeight: 600, distanceToBottom: 300))
        #expect(!PadTimelineJumpPolicy.isAtLatest(tailMinY: 0, viewportHeight: 0, distanceToBottom: 0))
        #expect(PadTimelineJumpPolicy.isAtLatest(tailMinY: 580, viewportHeight: 600, distanceToBottom: 12))
        #expect(PadTimelineJumpPolicy.isAtLatest(tailMinY: 100, viewportHeight: 600, distanceToBottom: 0))
    }

    @Test func nativeJumpCompletionDoesNotWaitForStaleLazyMeasurements() {
        #expect(PadTimelineJumpPolicy.correctionCompleted(nativeNearBottom: true,
            tailMinY: nil, viewportHeight: 0, distanceToBottom: 300))
        #expect(!PadTimelineJumpPolicy.correctionCompleted(nativeNearBottom: false,
            tailMinY: 580, viewportHeight: 600, distanceToBottom: 0))
        #expect(PadTimelineJumpPolicy.correctionCompleted(nativeNearBottom: nil,
            tailMinY: 580, viewportHeight: 600, distanceToBottom: 0))
    }

    @Test func explicitJumpHidesButtonIndependentlyOfCompletionMeasurements() {
        var viewport = ConversationViewportState(followsLatest: false, hasNewMessagesBelow: true)
        viewport.jumpToLatest()
        #expect(!viewport.showsJumpToLatest)
        #expect(!viewport.hasNewMessagesBelow)
        // Missing geometry means correction is still pending, not that the
        // user has returned to reading history.
        #expect(!PadTimelineJumpPolicy.correctionCompleted(nativeNearBottom: nil,
            tailMinY: nil, viewportHeight: 600, distanceToBottom: 0))
        #expect(!viewport.showsJumpToLatest)
        let followsTailUpdate = viewport.timelineTailDidChange()
        #expect(followsTailUpdate)
        #expect(!viewport.showsJumpToLatest)
        viewport.updateFromUserViewport(isNearBottom: false)
        #expect(viewport.showsJumpToLatest)
    }

    @Test func persistentOutlineSelectionOnlyAppearsInTheThreeColumnLayout() {
        #expect(!PadWorkspaceLayoutPolicy.showsPersistentOutlineSelection(
            isRegularWidth: false,
            width: 1_200
        ))
        #expect(!PadWorkspaceLayoutPolicy.showsPersistentOutlineSelection(
            isRegularWidth: true,
            width: 1_071
        ))
        #expect(PadWorkspaceLayoutPolicy.showsPersistentOutlineSelection(
            isRegularWidth: true,
            width: 1_072
        ))
    }

    @Test func compactSettingsNavigateIntoDetailsInsteadOfSelectingAnInvisibleSplitColumn() {
        #expect(PadSettingsNavigationPolicy.usesStack(isCompactWidth: true))
        #expect(!PadSettingsNavigationPolicy.usesStack(isCompactWidth: false))
    }

    @Test func originalResponseArrivingAfterReceiptSettlementDoesNotReportMismatch() async throws {
        let name = "corptie-ipad-command-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CompletedCommandProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://slow-command.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.drafts["session:a"] = "/goal test"
        let worker = Task { await workspace.command(connection, stop: false) }
        for _ in 0..<100 where workspace.pending == nil { try await Task.sleep(for: .milliseconds(1)) }
        let pending = try #require(workspace.pending)
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "sessionId": "session:a",
            "requestId": pending.requestID, "kind": "conversation_command", "status": "completed", "updatedAt": "now"])
        workspace.settle(try JSONDecoder().decode(ClientCommandReceipt.self, from: data))
        await worker.value
        #expect(workspace.pending == nil)
        #expect(workspace.status.isEmpty)
        #expect(connection.notice.isEmpty)
        #expect(workspace.drafts["session:a"] == "")
    }

    @Test func slashSubmissionUsesCommandRouteAndPreservesHistory() async throws {
        let name = "corptie-ipad-command-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CompletedCommandProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://command.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.messages = [ClientMessage(id: "history", text: "保留历史")]
        workspace.drafts["session:a"] = "/goal test"
        await workspace.command(connection, stop: false)
        #expect(workspace.pending == nil)
        #expect(defaults.data(forKey: "pendingCommand") == nil)
        #expect(workspace.drafts["session:a"] == "")
        #expect(workspace.visibleMessages.map(\.id) == ["history", "command:result"])
        #expect(workspace.visibleMessages.last?.type == "commandExecution")
        #expect(workspace.outgoingStates.isEmpty)
        #expect(workspace.status.isEmpty)
        #expect(connection.notice.isEmpty)
        workspace.applyLatestWindow(workspace.visibleMessages, cursor: nil, revision: 1)
        #expect(workspace.visibleMessages.map(\.id) == ["history", "command:result"])
        #expect(workspace.outgoingMessages["session:a"]?.isEmpty == true)
    }

    @Test func completedCommandKeepsEditedDraftAndStaysInOriginalConversation() throws {
        let name = "corptie-ipad-command-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "logical:a"
        workspace.drafts["logical:a"] = "/goal test"
        workspace.pending = PendingCommand(requestID: "request_123", sessionID: "session:a",
            kind: "conversation_command", serverID: "server:a", address: "https://example.invalid", draftSessionID: "logical:a")
        workspace.captureSubmission(requestID: "request_123", sessionID: "logical:a")
        workspace.drafts["logical:a"] = "新草稿"
        workspace.selection = "logical:b"
        let receipt = try JSONDecoder().decode(ClientCommandReceipt.self, from: Data(#"{"schemaVersion":1,"sessionId":"session:a","requestId":"request_123","kind":"conversation_command","status":"completed","updatedAt":"now","commandResult":{"text":"目标已设置","truncated":false,"messageId":"command:result"}}"#.utf8))
        workspace.settle(receipt)
        #expect(workspace.pending == nil)
        #expect(workspace.drafts["logical:a"] == "新草稿")
        #expect(workspace.visibleMessages.isEmpty)
        #expect(workspace.outgoingMessages["logical:a"]?.first?.text == "目标已设置")
    }

    @Test func slashAttachmentsAreNotSilentlyDiscarded() async {
        let name = "corptie-ipad-command-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.drafts["session:a"] = "/goal test"
        workspace.draftImages["session:a"] = [ClientDraftImage(fileName: "test.png", data: Data([1]))]
        await workspace.command(PadConnection(), stop: false)
        #expect(workspace.pending == nil)
        #expect(workspace.status.contains("单独发送"))
        #expect(workspace.drafts["session:a"] == "/goal test")
        #expect(workspace.draftImages["session:a"]?.count == 1)
    }

    @Test func sendRefreshPreservesHistoryAndReconcilesExactlyOneOutgoingMessage() throws {
        let workspace = PadWorkspace()
        workspace.selection = "session:a"
        let history = ClientMessage(id: "history", text: "previous")
        let outgoing = ClientMessage(id: "client:send", text: "new message")
        workspace.messages = [history]
        workspace.before = "earlier"
        workspace.lastTimelineRevision = 10
        workspace.outgoingMessages["session:a"] = [outgoing]
        workspace.outgoingStates[outgoing.id] = "Sent"
        workspace.applyLatestWindow([], cursor: nil, revision: 11)
        #expect(workspace.visibleMessages.map(\.id) == [history.id, outgoing.id])
        #expect(workspace.before == "earlier")
        let processing = try JSONDecoder().decode(ClientMessage.self, from: Data(#"{"id":"client:send","type":"userMessage","text":"new message","userMessageStatus":"processing"}"#.utf8))
        workspace.applyLatestWindow([history, processing], cursor: nil, revision: 12)
        #expect(workspace.visibleMessages.map(\.id) == [history.id, outgoing.id])
        #expect(workspace.outgoingMessages["session:a"]?.isEmpty == true)
        #expect(workspace.outgoingStates[outgoing.id] == nil)
        #expect(workspace.messages.last?.userMessageStatus == "processing")
        workspace.applyLatestWindow([], cursor: nil, revision: 11)
        workspace.applyLatestWindow([], cursor: nil, revision: 12)
        #expect(workspace.messages.count == 2)
        workspace.selection = "session:b"
        #expect(workspace.visibleMessages.isEmpty)
        #expect(workspace.lastTimelineRevision == nil)
    }

    @Test func sharedMessageStateNeverEquatesReceiptAcceptanceWithProcessing() {
        #expect(UserMessageProcessingState(authoritativeValue: nil, legacyStatus: "accepted") == nil)
        #expect(UserMessageProcessingState(authoritativeValue: nil, legacyStatus: "running") == .processing)
        #expect(UserMessageProcessingState(authoritativeValue: "consumed", legacyStatus: "running") == .consumed)
        #expect(UserMessageProcessingState(authoritativeValue: "future", legacyStatus: "running") == nil)
        #expect(ClientSessionAPI.messageID(deviceID: "device:one", requestID: "request_123") == "client:e1257168015d1940a75d46870e4a8d7b50f29d38f1d7506c461ff2111cc06b26")
    }
    @Test func startupWithoutSavedBackendFinishesAndDoesNotRetryAfterDisconnect() async {
        let connection = PadConnection()
        connection.address = ""
        connection.serverID = ""
        await connection.restoreLastConnection()
        #expect(!connection.restoringConnection)
        #expect(!connection.connected)
        connection.disconnect()
        let notice = connection.notice
        connection.address = "invalid"
        connection.serverID = "server:test"
        await connection.restoreLastConnection()
        #expect(connection.notice == notice)
        #expect(!connection.connected)
    }

    @Test func startupFailureReturnsToConnectionPage() async {
        let connection = PadConnection()
        connection.address = "invalid"
        connection.serverID = "server:test"
        await connection.restoreLastConnection()
        #expect(!connection.restoringConnection)
        #expect(!connection.connected)
        #expect(!connection.lanConnectionNotice.isEmpty)
    }

    @Test func scanValidatesBeforeReplacingFieldsAndDoesNotPersistSecret() throws {
        let connection = PadConnection()
        let savedAddress = UserDefaults.standard.string(forKey: "serverAddress")
        connection.address = "https://previous.local"
        connection.hasSavedPairing = true
        #expect(throws: (any Error).self) { try connection.applyPairingCode("https://not-a-pairing-code") }
        #expect(connection.address == "https://previous.local")
        let code = DevicePairingCode(address: "https://mac.local:8443", serverId: "server:scan",
            pairingId: UUID().uuidString, pairingSecret: String(repeating: "a", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000)
        try connection.applyPairingCode(code.encoded())
        #expect(connection.address == code.address)
        #expect(connection.serverID == code.serverId)
        #expect(connection.secret == code.pairingSecret)
        #expect(!connection.connected)
        #expect(connection.claim == nil)
        #expect(!connection.hasSavedPairing)
        #expect(UserDefaults.standard.string(forKey: "serverAddress") == savedAddress)
        connection.busy = true
        #expect(throws: (any Error).self) { try connection.applyPairingCode(code.encoded()) }
    }
    @Test func paginationPreservesIdentityAndReplacesUpdatedRows() {
        struct Row: Identifiable { let id: String; let value: Int }
        let rows = PadWorkspace.merge([Row(id: "a", value: 1), Row(id: "b", value: 2)], [Row(id: "a", value: 3), Row(id: "c", value: 4)])
        #expect(rows.map(\.id) == ["a", "b", "c"])
        #expect(rows.map(\.value) == [3, 2, 4])
    }

    @Test func historyAutoLoadRequiresReaderPositionAndRearmsForNewCursor() {
        var gate = PadHistoryAutoLoadGate()
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: false, userInitiated: true, underfilled: false,
                                   isLoading: false, connectionBusy: false) == nil)
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: true, userInitiated: false, underfilled: false,
                                   isLoading: false, connectionBusy: false) == nil)
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: false,
                                   connectionBusy: false) == "p1")
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: false,
                                   connectionBusy: false) == nil)
        #expect(gate.requestCursor(scope: "s1", before: "p2", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: false, connectionBusy: false) == "p2")
        #expect(gate.requestCursor(scope: "s2", before: "p1", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: false, connectionBusy: false) == "p1")
    }

    @Test func historyAutoLoadBootstrapsUnderfilledTimelineWithoutDuplicateRequests() {
        var gate = PadHistoryAutoLoadGate()
        for index in 1...4 {
            let cursor = "p\(index)"
            #expect(gate.requestCursor(scope: "s1", before: cursor, nearTop: true, userInitiated: false, underfilled: true,
                                       isLoading: false,
                                       connectionBusy: false) == cursor)
            #expect(gate.requestCursor(scope: "s1", before: cursor, nearTop: true, userInitiated: false, underfilled: true,
                                       isLoading: false,
                                       connectionBusy: false) == nil)
        }
        #expect(gate.requestCursor(scope: "s1", before: "p5", nearTop: true, userInitiated: false, underfilled: true,
                                   isLoading: false,
                                   connectionBusy: false) == nil)
        #expect(gate.requestCursor(scope: "s2", before: "p5", nearTop: true, userInitiated: false, underfilled: true,
                                   isLoading: false, connectionBusy: false) == "p5")
    }

    @Test func historyAutoLoadDoesNotConsumeTriggerWhileTransportIsBusy() {
        var gate = PadHistoryAutoLoadGate()
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: true,
                                   connectionBusy: false) == nil)
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: false,
                                   connectionBusy: true) == nil)
        #expect(gate.requestCursor(scope: "s1", before: "p1", nearTop: true, userInitiated: true, underfilled: false,
                                   isLoading: false,
                                   connectionBusy: false) == "p1")
    }

    @Test func missingSessionIsOnlyUnavailableAfterInventoryIsComplete() throws {
        let workspace = PadWorkspace()
        workspace.sessionCursor = "more"
        #expect(!workspace.sessionIsKnownUnavailable("session:missing"))
        workspace.sessionCursor = nil
        #expect(workspace.sessionIsKnownUnavailable("session:missing"))
        let session = try JSONDecoder().decode(ClientSession.self, from: Data(#"{"id":"session:known","title":"Known","sessionKind":"worker","executionStatus":"completed","updatedAt":"now"}"#.utf8))
        workspace.sessions = [session]
        workspace.rebuildGroups()
        #expect(!workspace.sessionIsKnownUnavailable("session:known"))
    }

    @Test func restartRetainsUnknownCommandAndMatchingReceiptNeverErasesNewDraft() throws {
        let name = "corptie-ipad-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let command = PendingCommand(requestID: "request_123", sessionID: "session:a", kind: "send", serverID: "server:a", address: "https://example.invalid")
        defaults.set(try JSONEncoder().encode(command), forKey: "pendingCommand")
        let workspace = PadWorkspace(defaults: defaults)
        #expect(workspace.pending?.requestID == "request_123")
        workspace.drafts["session:a"] = "Keep me"
        workspace.draftImages["session:a"] = [ClientDraftImage(fileName: "test.png", data: Data([1]))]
        workspace.draftMentions["session:a"] = [ClientDraftMention(targetType: "work", targetId: "work:a", displayName: "A")]
        func receipt(_ id: String, _ status: String) throws -> ClientCommandReceipt {
            try JSONDecoder().decode(ClientCommandReceipt.self, from: Data("{\"schemaVersion\":1,\"sessionId\":\"session:a\",\"requestId\":\"\(id)\",\"kind\":\"send\",\"status\":\"\(status)\",\"updatedAt\":\"now\"}".utf8))
        }
        workspace.settle(try receipt("request_123", "unknown"))
        #expect(workspace.pending != nil)
        workspace.settle(try receipt("other", "accepted"))
        #expect(workspace.pending != nil)
        #expect(workspace.drafts["session:a"] == "Keep me")
        #expect(workspace.draftImages["session:a"]?.count == 1)
        #expect(workspace.draftMentions["session:a"]?.count == 1)
        workspace.settle(try receipt("request_123", "accepted"))
        #expect(workspace.pending == nil)
        #expect(workspace.status.isEmpty)
        #expect(workspace.drafts["session:a"] == "Keep me")
        #expect(workspace.draftImages["session:a"]?.count == 1)
        #expect(workspace.draftMentions["session:a"]?.count == 1)
        #expect(PadWorkspace(defaults: defaults).pending == nil)
    }

    @Test func rejectedMessageDoesNotBecomeUncertainAndDoesNotLockComposer() throws {
        let name = "corptie-rejection-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.drafts["session:a"] = "/goal build something"
        workspace.pending = PendingCommand(requestID: "request_123", sessionID: "session:a",
            kind: "send", serverID: "server:a", address: "https://example.invalid")
        workspace.outgoingRequestIDs["request_123"] = "client:a"
        workspace.outgoingStates["client:a"] = "Sending"
        workspace.messages = [ClientMessage(id: "history", text: "previous")]
        #expect(workspace.rejectBeforeDispatch(ClientServiceFailure(statusCode: 400, code: "INVALID_MESSAGE"), requestID: "request_123"))
        #expect(workspace.pending == nil)
        #expect(workspace.outgoingStates["client:a"]?.contains("发送失败") == true)
        #expect(workspace.outgoingStates["client:a"]?.contains("待核对") == false)
        #expect(workspace.drafts["session:a"] == "/goal build something")
        #expect(workspace.messages.count == 1)
    }

    @Test func timeoutConflictAndUnstructuredHTTPFailureRetainRequestIdentity() {
        let name = "corptie-uncertain-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.pending = PendingCommand(requestID: "request_123", sessionID: "session:a",
            kind: "send", serverID: "server:a", address: "https://example.invalid")
        for error: any Error in [URLError(.timedOut),
            ClientServiceFailure(statusCode: 409, code: "IDEMPOTENCY_CONFLICT"),
            ClientConnectionError.httpStatus(400),
            ClientServiceFailure(statusCode: 500, code: "UNKNOWN_ERROR")] {
            #expect(!workspace.rejectBeforeDispatch(error, requestID: "request_123"))
            #expect(workspace.pending?.requestID == "request_123")
        }
        #expect(!workspace.rejectBeforeDispatch(ClientServiceFailure(statusCode: 400, code: "INVALID_MESSAGE"), requestID: "other"))
    }

    @Test func acceptanceOnlyClearsUnmodifiedSubmissionSnapshot() throws {
        let name = "corptie-snapshot-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        let receipt = try JSONDecoder().decode(ClientCommandReceipt.self, from: Data(#"{"schemaVersion":1,"sessionId":"session:a","requestId":"request_123","kind":"send","status":"accepted","updatedAt":"now"}"#.utf8))
        for edited in [false, true] {
            workspace.pending = PendingCommand(requestID: "request_123", sessionID: "session:a",
                kind: "send", serverID: "server:a", address: "https://example.invalid")
            workspace.drafts["session:a"] = "submitted"
            workspace.captureSubmission(requestID: "request_123", sessionID: "session:a")
            if edited {
                workspace.drafts["session:a"] = "new text"
                workspace.drafts["session:a"] = "submitted" // Same text, different edit revision.
            }
            workspace.settle(receipt)
            #expect(workspace.drafts["session:a"] == (edited ? "submitted" : ""))
            #expect(workspace.pending == nil)
        }
    }

    @Test func actualHTTPRejectionSettlesPendingWithoutLosingDraft() async throws {
        let name = "corptie-http-rejection-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RejectedCommandProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://command.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.drafts["session:a"] = "/goal test"
        await workspace.command(connection, stop: false)
        #expect(workspace.pending == nil)
        #expect(defaults.data(forKey: "pendingCommand") == nil)
        #expect(workspace.drafts["session:a"] == "/goal test")
        #expect(connection.notice.contains("消息未发送"))
    }

    @Test func selectingAnotherSessionNeverCarriesMessagesOrCapabilities() {
        let workspace = PadWorkspace()
        workspace.status = "old receipt"
        workspace.conversationNotice = "old error"
        workspace.before = "old-anchor"
        workspace.configuringComposer = true
        let composerGeneration = workspace.composerGeneration
        workspace.clearSelectionState()
        #expect(workspace.before == nil)
        #expect(workspace.capabilities == nil)
        #expect(workspace.status.isEmpty)
        #expect(workspace.conversationNotice.isEmpty)
        #expect(!workspace.configuringComposer)
        #expect(workspace.composerConfiguration == nil)
        #expect(workspace.composerGeneration > composerGeneration)
    }

    @Test func emptyRealtimeComposerDoesNotEraseAConfigurationLoadedSeparately() throws {
        let workspace = PadWorkspace()
        let supported = try JSONDecoder().decode(ClientSessionCapabilities.self, from: Data(#"{"schemaVersion":1,"sessionId":"session:a","readMessages":true,"send":{"available":true},"stop":{"available":true},"composer":true}"#.utf8))
        let unsupported = try JSONDecoder().decode(ClientSessionCapabilities.self, from: Data(#"{"schemaVersion":1,"sessionId":"session:a","readMessages":true,"send":{"available":true},"stop":{"available":true},"composer":false}"#.utf8))
        let configuration = try JSONDecoder().decode(ClientComposerConfiguration.self, from: Data(#"{"schemaVersion":1,"sessionId":"session:a","currentModel":"gpt-6.1-sol","currentReasoningLevel":"high","models":[{"id":"gpt-6.1-sol","name":"GPT-6.1 Sol","reasoningLevels":["high"],"defaultReasoningLevel":"high"}],"switchModel":{"available":true},"switchReasoning":{"available":true}}"#.utf8))

        workspace.mergeComposerConfiguration(configuration, capabilities: supported)
        workspace.mergeComposerConfiguration(nil, capabilities: supported)
        #expect(workspace.composerConfiguration?.currentModel == "gpt-6.1-sol")

        workspace.mergeComposerConfiguration(nil, capabilities: unsupported)
        #expect(workspace.composerConfiguration == nil)
    }

    @Test func structuredNotFoundDoesNotClaimAnActiveSessionWasArchived() {
        let message = PadConnection.explain(ClientServiceFailure(statusCode: 404, code: "SESSION_NOT_AVAILABLE"))
        #expect(message.contains("归档") == false)
        #expect(message.contains("刷新"))
    }

    @Test func conversationLoadIsNotDroppedByBackgroundWorkAndUsesResolvedSessionID() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ConversationProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://conversation.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        connection.busy = true
        connection.notice = "stale error"
        ConversationProtocol.paths = []
        let workspace = PadWorkspace()
        workspace.selection = "logical:test"

        await workspace.load(connection)

        #expect(workspace.conversationNotice.isEmpty)
        #expect(workspace.capabilities?.sessionId == "session:resolved")
        #expect(workspace.messages.first?.text == "available")
        #expect(ConversationProtocol.paths.contains("/client/v1/sessions/session:resolved/messages"))
    }

    @Test func serializedOperationsRejectConcurrentDuplicate() async {
        let connection = PadConnection()
        var calls = 0
        await connection.perform {
            calls += 1
            await connection.perform { calls += 1 }
        }
        #expect(calls == 1)
        #expect(!connection.busy)
    }
}

private final class CompletedCommandProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.url?.path == "/client/v1/sessions/session:a/conversation-commands")
        #expect(request.httpMethod == "POST")
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        #expect(body?["name"] as? String == "goal")
        #expect(body?["arguments"] as? String == "test")
        #expect(body?["confirmed"] as? Bool == false)
        let json: [String: Any] = ["schemaVersion": 1, "sessionId": "session:a",
            "requestId": body?["requestId"] as? String ?? "invalid", "kind": "conversation_command",
            "status": "completed", "updatedAt": "now",
            "commandResult": ["text": "目标已设置", "truncated": false, "messageId": "command:result"]]
        let responseData = try! JSONSerialization.data(withJSONObject: json)
        let deliver: @Sendable () -> Void = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: responseData)
            client?.urlProtocolDidFinishLoading(self)
        }
        if request.url?.host == "slow-command.invalid" {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1, execute: deliver)
        } else { deliver() }
    }
    override func stopLoading() {}
}

private final class RejectedCommandProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 400,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"code":"INVALID_MESSAGE"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class ConversationProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var paths: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.paths.append(path)
        let json = path.hasSuffix("/capabilities")
            ? #"{"schemaVersion":1,"sessionId":"session:resolved","readMessages":true,"send":{"available":true},"stop":{"available":false}}"#
            : #"{"schemaVersion":1,"sessionId":"session:resolved","hasEarlier":false,"items":[{"id":"item:1","type":"agentMessage","text":"available"}]}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
