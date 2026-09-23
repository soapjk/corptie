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
}
