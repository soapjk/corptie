import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadWorkActivityTests {
    @Test func boundSessionWinsAndDiscussionDoesNotMakeTasksLookRunning() throws {
        let key = "pad-work-activity-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: key)!
        defer { defaults.removePersistentDomain(forName: key) }
        let workspace = PadWorkspace(defaults: defaults)
        let decoder = JSONDecoder()
        workspace.tasks = try decoder.decode([ClientTask].self, from: Data(#"[{"id":"t","title":"Task","workId":"w","lifecycleState":"active","executionStatus":"running","currentSessionId":"s","updatedAt":"now"},{"id":"unbound","title":"Task","workId":"w2","lifecycleState":"active","executionStatus":"running","updatedAt":"now"}]"#.utf8))
        func sessions(_ status: String) throws -> [ClientSession] {
            try decoder.decode([ClientSession].self, from: Data("""
            [{"id":"s","title":"Task session","executionStatus":"\(status)","updatedAt":"now"},
             {"id":"chat","title":"Discussion","workId":"w","sessionKind":"workChat","executionStatus":"running","updatedAt":"now"}]
            """.utf8))
        }
        workspace.sessions = try sessions("failed")
        workspace.rebuildGroups()
        #expect(workspace.processingWorkIDs.isEmpty)
        #expect(workspace.executionByTaskID["t"] == "failed")
        #expect(workspace.activityByTaskID["t"] == .failed)
        #expect(workspace.activityByTaskID["unbound"] == .noSession)
        #expect(workspace.sessionIDByTaskID["t"] == "s")
        #expect(workspace.discussionsByWork["w"]?.first?.id == "chat")
        workspace.sessions = try sessions("running")
        workspace.rebuildGroups()
        #expect(workspace.processingWorkIDs == ["w"])
        workspace.sessions = try sessions("completed")
        workspace.rebuildGroups()
        #expect(workspace.processingWorkIDs.isEmpty)
        #expect(workspace.executionByTaskID["t"] == "completed")
        workspace.sessions += try decoder.decode([ClientSession].self, from: Data(#"[{"id":"older","title":"Old","taskId":"unbound","executionStatus":"failed","updatedAt":"2026-09-18"},{"id":"latest","title":"Latest","taskId":"unbound","executionStatus":"running","updatedAt":"2026-09-19"}]"#.utf8))
        workspace.rebuildGroups()
        #expect(workspace.activityByTaskID["unbound"] == .processing)
        #expect(workspace.sessionIDByTaskID["unbound"] == "latest")
        #expect(workspace.processingWorkIDs == ["w2"])
        workspace.tasks = []
        workspace.rebuildGroups()
        #expect(workspace.executionByTaskID.isEmpty)
        #expect(workspace.activityByTaskID.isEmpty)
        #expect(workspace.sessionIDByTaskID.isEmpty)
    }

    @Test func timelineDeltaUpdatesActivityAndReordersWithoutServerInventory() throws {
        let key = "pad-work-activity-delta-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: key)!
        defer { defaults.removePersistentDomain(forName: key) }
        let workspace = PadWorkspace(defaults: defaults)
        let decoder = JSONDecoder()

        workspace.works = try decoder.decode([ClientWork].self, from: Data("""
        [{"id":"w1","name":"Work 1","status":"active","updatedAt":"2026-09-01"},
         {"id":"w2","name":"Work 2","status":"active","updatedAt":"2026-09-02"}]
        """.utf8))

        workspace.tasks = try decoder.decode([ClientTask].self, from: Data("""
        [{"id":"t1","title":"Task 1","workId":"w1","lifecycleState":"active","executionStatus":"running","currentSessionId":"s1","updatedAt":"2026-09-01"},
         {"id":"t2","title":"Task 2","workId":"w2","lifecycleState":"active","executionStatus":"running","currentSessionId":"s2","updatedAt":"2026-09-02"}]
        """.utf8))

        workspace.sessions = try decoder.decode([ClientSession].self, from: Data("""
        [{"id":"s1","title":"Task 1 Session","workId":"w1","taskId":"t1","executionStatus":"running","lastMessageAt":"2026-09-01","updatedAt":"2026-09-01"},
         {"id":"s2","title":"Task 2 Session","workId":"w2","taskId":"t2","executionStatus":"running","lastMessageAt":"2026-09-02","updatedAt":"2026-09-02"},
         {"id":"chat1","title":"Chat 1","executionStatus":"complete","lastMessageAt":"2026-09-01","updatedAt":"2026-09-01"},
         {"id":"chat2","title":"Chat 2","executionStatus":"complete","lastMessageAt":"2026-09-02","updatedAt":"2026-09-02"}]
        """.utf8))

        workspace.rebuildGroups()
        #expect(workspace.independentSessions.map(\.id) == ["chat2", "chat1"])
        #expect(PadOutlineSort.updated.works(workspace.works, latestSessionActivity: workspace.latestSessionActivityByWork).map(\.id) == ["w2", "w1"])

        // Receive pushed timeline delta for independent chat1 with newer message
        let deltaChat1JSON = """
        {
            "schemaVersion": 2,
            "kind": "delta",
            "sessionId": "chat1",
            "snapshotRequired": false,
            "baseRevision": 1,
            "revision": 2,
            "currentRevision": 2,
            "hasMore": false,
            "changes": [
                {
                    "revision": 2,
                    "itemId": "msg:c1",
                    "operation": "append",
                    "item": {
                        "id": "msg:c1",
                        "type": "user",
                        "text": "Hello in chat 1",
                        "createdAt": "2026-10-02T10:00:00Z"
                    }
                }
            ]
        }
        """
        let deltaChat1 = try decoder.decode(ClientTimelineDelta.self, from: Data(deltaChat1JSON.utf8))
        _ = workspace.applyBackgroundTimeline(deltaChat1)

        #expect(workspace.effectiveRecordedActivity(for: "chat1") == "2026-10-02T10:00:00Z")
        #expect(workspace.independentSessions.map(\.id) == ["chat1", "chat2"])

        // Receive pushed timeline delta for task session s1 with newer message
        let deltaS1JSON = """
        {
            "schemaVersion": 2,
            "kind": "delta",
            "sessionId": "s1",
            "snapshotRequired": false,
            "baseRevision": 1,
            "revision": 2,
            "currentRevision": 2,
            "hasMore": false,
            "changes": [
                {
                    "revision": 2,
                    "itemId": "msg:s1",
                    "operation": "append",
                    "item": {
                        "id": "msg:s1",
                        "type": "assistant",
                        "text": "Task update",
                        "createdAt": "2026-10-03T12:00:00Z"
                    }
                }
            ]
        }
        """
        let deltaS1 = try decoder.decode(ClientTimelineDelta.self, from: Data(deltaS1JSON.utf8))
        _ = workspace.applyBackgroundTimeline(deltaS1)

        #expect(workspace.effectiveRecordedActivity(for: "s1") == "2026-10-03T12:00:00Z")
        #expect(workspace.latestSessionActivityByTask["t1"] == "2026-10-03T12:00:00Z")
        #expect(workspace.latestSessionActivityByWork["w1"] == "2026-10-03T12:00:00Z")
        #expect(PadOutlineSort.updated.works(workspace.works, latestSessionActivity: workspace.latestSessionActivityByWork).map(\.id) == ["w1", "w2"])

        // Rebuilding groups with existing inventory does not regress client-recorded activity
        workspace.rebuildGroups()
        #expect(workspace.latestSessionActivityByTask["t1"] == "2026-10-03T12:00:00Z")
        #expect(workspace.latestSessionActivityByWork["w1"] == "2026-10-03T12:00:00Z")
        #expect(workspace.independentSessions.map(\.id) == ["chat1", "chat2"])
        #expect(PadOutlineSort.updated.tasks(workspace.tasks, latestSessionActivity: workspace.latestSessionActivityByTask).map(\.id) == ["t1", "t2"])

        // Task bound via currentSessionId without session.taskId still receives session message activity
        let unboundTask = try decoder.decode(ClientTask.self, from: Data("""
        {"id":"t3","title":"Task 3","workId":"w1","lifecycleState":"active","executionStatus":"running","currentSessionId":"s3","updatedAt":"2026-09-01"}
        """.utf8))
        let workerSession = try decoder.decode(ClientSession.self, from: Data("""
        {"id":"s3","title":"Task 3 Session","workId":"w1","executionStatus":"running","lastMessageAt":"2026-10-04T15:00:00Z","updatedAt":"2026-10-04T15:00:00Z"}
        """.utf8))
        workspace.tasks.append(unboundTask)
        workspace.sessions.append(workerSession)
        workspace.rebuildGroups()
        #expect(workspace.latestSessionActivityByTask["t3"] == "2026-10-04T15:00:00Z")
        #expect(PadOutlineSort.updated.tasks(workspace.tasks, latestSessionActivity: workspace.latestSessionActivityByTask).map(\.id) == ["t3", "t1", "t2"])
    }
}
