import AppKit
import Foundation
import Testing
import XCTest
@testable import CorptieMac

@MainActor
struct ScheduledSessionModelTests {
    @Test func decodesStructuredMessageAndAuthoritativeRunHistory() throws {
        let data = Data(
            """
            {
              "taskId":"scheduled_task:1",
              "logicalSessionId":"session:1",
              "message":{"text":"检查状态","type":"scheduled_session_message","payload":{}},
              "scheduleType":"interval",
              "runAt":"2026-08-23T00:00:00.000Z",
              "nextRunAt":"2026-08-23T01:00:00.000Z",
              "expiresAt":"2026-09-23T01:00:00.000Z",
              "intervalSeconds":3600,
              "timezone":"Asia/Shanghai",
              "status":"active",
              "missedPolicy":"coalesce_once",
              "lastRunId":"scheduled_run:1",
              "lastRunStatus":"queued",
              "lastRunAt":"2026-08-23T00:30:00.000Z",
              "resourceVersion":3,
              "createdAt":"2026-08-22T12:00:00.000Z",
              "updatedAt":"2026-08-22T12:01:00.000Z",
              "runs":[{
                "runId":"scheduled_run:1","taskId":"scheduled_task:1",
                "scheduledFor":"2026-08-22T13:00:00.000Z",
                "triggerKind":"scheduled","triggerReason":"schedule_due",
                "status":"queued","attemptCount":1,
                "agentWorkItemId":"agent_work:1","targetTurnId":null,
                "errorCode":null,"errorMessage":null,
                "claimedAt":"2026-08-22T13:00:00.000Z",
                "queuedAt":"2026-08-22T13:00:01.000Z",
                "startedAt":null,"completedAt":null,
                "createdAt":"2026-08-22T13:00:00.000Z",
                "updatedAt":"2026-08-22T13:00:01.000Z"
              }]
            }
            """.utf8
        )

        let task = try JSONDecoder().decode(ScheduledSessionTask.self, from: data)

        #expect(task.message == "检查状态")
        #expect(task.presentationStatus == .queued)
        #expect(task.runs.first?.agentWorkItemId == "agent_work:1")
        #expect(task.runs.first?.status.presentation == .queued)
        #expect(task.createdAt == "2026-08-22T12:00:00.000Z")
        #expect(task.lastRunAt == "2026-08-23T00:30:00.000Z")
        #expect(task.nextRunAt == "2026-08-23T01:00:00.000Z")
        #expect(task.expiresAt == "2026-09-23T01:00:00.000Z")
        #expect(task.timezone == "Asia/Shanghai")
    }

    @Test func validatesEveryClientSideBoundary() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(ScheduledSessionTaskDraft.fresh(message: "检查", now: now).validationError(now: now) == .emptyTitle)

        var once = ScheduledSessionTaskDraft.fresh(message: "检查", now: now)
        once.title = "检查任务"
        once.runAt = now
        #expect(once.validationError(now: now) == .pastRunAt)

        var interval = ScheduledSessionTaskDraft.fresh(message: "检查", now: now)
        interval.title = "周期检查"
        interval.scheduleType = .interval
        interval.intervalSeconds = 59
        #expect(interval.validationError(now: now) == .invalidInterval)
        interval.intervalSeconds = 60
        interval.timezone = "Mars/Olympus_Mons"
        #expect(interval.validationError(now: now) == .invalidTimezone)
    }

    @Test func createBodyUsesStructuredBackendContractAndTimeZone() throws {
        let runAt = Date(timeIntervalSince1970: 1_800_000_600)
        let draft = ScheduledSessionTaskDraft(
            title: "检查状态",
            message: "  检查状态  ",
            scheduleType: .once,
            runAt: runAt,
            intervalSeconds: 3600,
            timezone: "Asia/Shanghai",
            missedPolicy: .skip,
            expiresAt: Date(timeIntervalSince1970: 1_800_086_400)
        )

        let body = draft.requestBody()
        let message = body["message"] as? [String: String]

        #expect(message?["text"] == "检查状态")
        #expect(body["name"] as? String == "检查状态")
        #expect(body["scheduleType"] as? String == "once")
        #expect(body["timezone"] as? String == "Asia/Shanghai")
        #expect(body["missedPolicy"] as? String == "skip")
        #expect(body["runAt"] as? String == "2027-01-15T08:10:00.000Z")
        #expect(body["expiresAt"] as? String == "2027-01-16T08:00:00.000Z")
    }

    @Test func timeZoneSummaryDisplaysTheChosenZoneAndNextRun() {
        let draft = ScheduledSessionTaskDraft(
            title: "检查计划",
            message: "检查",
            scheduleType: .once,
            runAt: Date(timeIntervalSince1970: 1_800_000_600),
            intervalSeconds: 3600,
            timezone: "Asia/Shanghai",
            missedPolicy: .coalesceOnce,
            expiresAt: Date(timeIntervalSince1970: 1_800_086_400)
        )

        #expect(draft.summaryText.contains("Asia/Shanghai"))
        #expect(draft.summaryText.contains("下一次"))
        #expect(draft.summaryText.contains("过期"))
    }

    @Test func managementTimesUseTheSystemZoneInsteadOfTheTaskZone() throws {
        let shanghai = try #require(TimeZone(identifier: "Asia/Shanghai"))
        let instant = "2026-08-23T04:10:39.000Z"
        let displayed = try #require(ScheduledSessionManagementTimeFormatting.string(
            from: instant,
            timeZone: shanghai,
            locale: Locale(identifier: "en_US_POSIX")
        ))

        #expect(displayed.contains("12:10:39"))
        #expect(ScheduledSessionManagementTimeFormatting.timeZoneLabel(
            shanghai,
            at: try #require(ScheduledSessionDateFormatting.date(from: instant))
        ) == "Asia/Shanghai (UTC+08:00)")
    }

    @Test func taskLifecycleExposesTheFivePersistedStates() {
        #expect([ScheduledSessionTaskStatus.active, .cancelled, .completed, .expired, .error].map(\.rawValue)
            == ["active", "cancelled", "completed", "expired", "error"])
    }
}

@MainActor
struct ScheduledSessionBackendClientTests {
    @Test func listRequestLoadsRunHistoryInOneCollectionRequest() throws {
        let url = try #require(BackendClient.scheduledTaskListURL(
            baseURL: URL(string: "http://127.0.0.1:47322")!,
            logicalSessionId: "logical:one"
        ))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(url.path == "/scheduled-session-tasks")
        #expect(components.queryItems?.contains(URLQueryItem(name: "includeRuns", value: "true")) == true)
        #expect(components.queryItems?.contains(URLQueryItem(name: "logicalSessionId", value: "logical:one")) == true)
    }

    @Test func automationRefreshCoalescesEventsArrivingDuringAnActiveLoad() {
        var refresh = AutomationRefreshCoalescer()

        let startsInitialLoad = refresh.request()
        let coalescesBeforePass = refresh.request()
        #expect(startsInitialLoad)
        #expect(!coalescesBeforePass)
        refresh.beginPass()
        let coalescesDuringPass = refresh.request()
        let needsFollowUpPass = refresh.completePass()
        #expect(!coalescesDuringPass)
        #expect(needsFollowUpPass)

        refresh.beginPass()
        let finishesWithoutMoreEvents = refresh.completePass()
        #expect(!finishesWithoutMoreEvents)
        #expect(!refresh.isRunning)
        let startsNextIndependentLoad = refresh.request()
        #expect(startsNextIndependentLoad)
    }

    @Test func mapsEveryAuthoritativeBackendStateWithoutCallingQueuedRunning() {
        #expect(ScheduledSessionRunStatus(rawValue: "claimed").presentation == .due)
        #expect(ScheduledSessionRunStatus(rawValue: "queued").presentation == .queued)
        #expect(ScheduledSessionRunStatus(rawValue: "running").presentation == .running)
        #expect(ScheduledSessionRunStatus(rawValue: "completed").presentation == .completed)
        #expect(ScheduledSessionRunStatus(rawValue: "failed").presentation == .failed)
        #expect(ScheduledSessionRunStatus(rawValue: "missed").presentation == .missed)
        #expect(ScheduledSessionRunStatus(rawValue: "cancelled").presentation == .cancelled)
        #expect(ScheduledSessionRunStatus(rawValue: "future_state").presentation == .unknown("future_state"))
    }

    @Test func apiContractCoversCreateEditCancelAndRunNow() {
        #expect(ScheduledSessionAPIContract.collectionPath == "scheduled-session-tasks")
        #expect(ScheduledSessionAPIContract.itemPath(taskId: "scheduled_task:1") == "scheduled-session-tasks/scheduled_task:1")
        #expect(ScheduledSessionAPIContract.actionPath(taskId: "scheduled_task:1", action: .pause).hasSuffix("/pause"))
        #expect(ScheduledSessionAPIContract.actionPath(taskId: "scheduled_task:1", action: .resume).hasSuffix("/resume"))
        #expect(ScheduledSessionAPIContract.actionPath(taskId: "scheduled_task:1", action: .cancel).hasSuffix("/cancel"))
        #expect(ScheduledSessionAPIContract.actionPath(taskId: "scheduled_task:1", action: .runNow).hasSuffix("/run"))
        #expect(ScheduledSessionAPIContract.actionPath(taskId: "scheduled_task:1", action: .retry).hasSuffix("/resume"))
    }

    @Test func reconnectReconciliationDeduplicatesByIdAndRejectsWrongSessionOwnership() {
        let older = makeTask(id: "scheduled_task:1", sessionId: "session:1", version: 1, nextRunAt: "2026-08-23T02:00:00.000Z")
        let newer = makeTask(id: "scheduled_task:1", sessionId: "session:1", version: 2, nextRunAt: "2026-08-23T01:00:00.000Z")
        let second = makeTask(id: "scheduled_task:2", sessionId: "session:1", version: 1, nextRunAt: "2026-08-23T03:00:00.000Z")
        let wrongSession = makeTask(id: "scheduled_task:3", sessionId: "session:other", version: 1, nextRunAt: nil)

        let reconciled = BackendClient.reconciledScheduledTasks(
            [older, second, wrongSession, newer],
            for: makeSession(id: "session:1")
        )

        #expect(reconciled.map(\.id) == ["scheduled_task:1", "scheduled_task:2"])
        #expect(reconciled.first?.resourceVersion == 2)
    }

    @Test func permanentBackendDiagnosticsDisableInvalidOperations() {
        let failed = ScheduledSessionTask(
            taskId: "scheduled_task:failed",
            logicalSessionId: "session:1",
            message: "检查",
            scheduleType: .once,
            runAt: "2026-08-23T00:00:00.000Z",
            nextRunAt: nil,
            intervalSeconds: nil,
            timezone: "UTC",
            status: .error,
            missedPolicy: .coalesceOnce,
            lastErrorCode: "ROUTE_UNAVAILABLE",
            lastErrorMessage: "No active binding",
            resourceVersion: 2,
            createdAt: "2026-08-22T00:00:00.000Z",
            updatedAt: "2026-08-22T00:00:00.000Z"
        )

        #expect(failed.operationsDisabledReason == "ROUTE_UNAVAILABLE · No active binding")
    }

    @Test func stateEventsResolveLogicalSessionFromTaskPayload() {
        let data = Data(
            """
            {"payload":{"task":{"taskId":"scheduled_task:1","logicalSessionId":"session:1"}}}
            """.utf8
        )

        #expect(ScheduledSessionEventMapping.sessionId(from: data) == "session:1")
        #expect(ScheduledSessionEventMapping.authoritativeEventNames.contains("ScheduledSessionRunQueued"))
        #expect(ScheduledSessionEventMapping.authoritativeEventNames.contains("ScheduledSessionRunStarted"))
        #expect(ScheduledSessionEventMapping.authoritativeEventNames.contains("ScheduledSessionRunCompleted"))
        #expect(ScheduledSessionEventMapping.authoritativeEventNames.contains("ScheduledSessionRunFailed"))
        #expect(ScheduledSessionEventMapping.authoritativeEventNames.contains("ScheduledSessionRunMissed"))
    }

    @Test func runHistoryTargetTurnLocatesTheActualTimelineRow() {
        let rows = [
            AppKitChatTimelineRow(
                id: "message:1", contentRevision: 1, nativeText: "User", copyText: "User",
                nativeStyle: .user, title: "User", metadata: "", expandableTurnId: nil, isExpanded: false
            ),
            AppKitChatTimelineRow(
                id: "process:turn:scheduled", contentRevision: 1, nativeText: "", copyText: "",
                nativeStyle: .process, title: "Running", metadata: "",
                expandableTurnId: "turn:scheduled", isExpanded: false
            )
        ]

        #expect(AppKitChatTimelineView.rowIndex(forTurnID: "turn:scheduled", in: rows) == 1)
        #expect(AppKitChatTimelineView.rowIndex(forTurnID: "turn:missing", in: rows) == nil)
    }
}

private func makeTask(
    id: String,
    sessionId: String,
    version: Int,
    nextRunAt: String?
) -> ScheduledSessionTask {
    ScheduledSessionTask(
        taskId: id,
        logicalSessionId: sessionId,
        message: "检查状态",
        scheduleType: .interval,
        runAt: "2026-08-23T00:00:00.000Z",
        nextRunAt: nextRunAt,
        intervalSeconds: 3600,
        timezone: "Asia/Shanghai",
        status: .active,
        missedPolicy: .coalesceOnce,
        resourceVersion: version,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z"
    )
}

private func makeSession(id: String) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Codex",
        agentId: nil,
        status: .complete,
        progress: 1,
        summary: "",
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: "2026-08-22T00:00:00.000Z",
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: nil
    )
}

@MainActor
final class ScheduledSessionUITests: XCTestCase {
    func testCreateAndEditControlsExposeStableAutomationIdentifiers() {
        XCTAssertNotNil(
            NSImage(
                systemSymbolName: ScheduledSessionAccessibilityID.composerSymbol,
                accessibilityDescription: nil
            )
        )
        XCTAssertEqual(ScheduledSessionAccessibilityID.composerEntry, "scheduled-session.composer.entry")
        XCTAssertEqual(ScheduledSessionAccessibilityID.detailSection, "scheduled-session.detail.section")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorTitle, "scheduled-session.editor.title")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorMessage, "scheduled-session.editor.message")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorScheduleType, "scheduled-session.editor.schedule-type")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorRunAt, "scheduled-session.editor.run-at")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorInterval, "scheduled-session.editor.interval")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorTimezone, "scheduled-session.editor.timezone")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorExpiresAt, "scheduled-session.editor.expires-at")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorMissedPolicy, "scheduled-session.editor.missed-policy")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorSummary, "scheduled-session.editor.summary")
        XCTAssertEqual(ScheduledSessionAccessibilityID.editorSave, "scheduled-session.editor.save")
    }

    func testOnlyTheMainAutomationTabExposesManagementControls() throws {
        XCTAssertFalse(ScheduledSessionTaskStatus.active.permitsPause)
        XCTAssertTrue(ScheduledSessionTaskStatus.error.permitsResume)
        XCTAssertFalse(ScheduledSessionTaskStatus.cancelled.permitsRunNow)

        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/ScheduledSessionViews.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(contents.contains("ScheduledSessionManagerView"))
        XCTAssertFalse(contents.contains("isShowingManager"))
        XCTAssertTrue(contents.contains("filter { $0.status == .active }"))
        XCTAssertTrue(contents.contains("Array(tasks.prefix(2))"))
        XCTAssertTrue(contents.contains("isExpanded.toggle()"))
        XCTAssertTrue(contents.contains("Text(task.name)"))
        for field in ["创建时间", "上次执行时间", "预计下次执行时间", "过期时间"] {
            XCTAssertTrue(contents.contains(field))
        }
    }

    func testSessionAutomationSummaryLivesInTheDetailCardNotAboveTheComposer() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let sessionsView = try String(
            contentsOf: sourceRoot.appendingPathComponent("SessionsView.swift"),
            encoding: .utf8
        )
        let conversationView = try String(
            contentsOf: sourceRoot.appendingPathComponent("FloatingRootView.swift"),
            encoding: .utf8
        )

        let detailCardStart = try XCTUnwrap(sessionsView.range(of: "private var sessionCard: some View"))
        let statusRange = try XCTUnwrap(
            sessionsView.range(
                of: "statusCard",
                range: detailCardStart.lowerBound..<sessionsView.endIndex
            )
        )
        let scheduleRange = try XCTUnwrap(
            sessionsView.range(
                of: "ScheduledSessionStrip(session: session)",
                range: statusRange.lowerBound..<sessionsView.endIndex
            )
        )
        XCTAssertLessThan(statusRange.lowerBound, scheduleRange.lowerBound)
        XCTAssertFalse(conversationView.contains("ScheduledSessionStrip(session: session)"))
    }
}
