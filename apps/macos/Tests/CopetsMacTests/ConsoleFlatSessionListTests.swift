import XCTest
@testable import CorptieMac

@MainActor
final class ConsoleFlatSessionListTests: XCTestCase {
    private func session(_ id: String, workID: String? = nil, taskID: String? = nil) throws -> TaskSession {
        var value = try JSONDecoder().decode(TaskSession.self, from: Data("""
        {"id":"\(id)","title":"\(id)","agent":"provider-neutral","status":"complete",
         "progress":1,"summary":"","updatedAt":"2026-11-11T00:00:00Z","accent":"cyan"}
        """.utf8))
        value.sessionKind = taskID != nil ? .worker : (workID != nil ? .workChat : .assistantChat)
        value.workId = workID
        value.taskId = taskID
        return value
    }

    func testListKeepsChatGroupSeparateFromAllProjectAndChildTaskSessions() throws {
        let rows = try (0..<1_000).map { index in
            SessionRowModel(session: try session("session-\(index)",
                workID: "work-\(index % 12)", taskID: "task-\(index)"))
        }
        let chat = SessionRowModel(session: try session("chat"))
        let workChat = SessionRowModel(session: try session("work-chat", workID: "work-0"))
        let result = ConsoleFlatSessionList.partitionedRows(rows + [chat, workChat], sort: .standard)
        XCTAssertEqual(result.projects.count, 1_001)
        XCTAssertEqual(result.chats.count, 1)
        XCTAssertTrue(result.projects[999] === rows[999])
        XCTAssertTrue(result.chats[0] === chat)
        XCTAssertTrue(result.projects[1_000] === workChat)
        XCTAssertFalse(result.projects.contains { $0.id == chat.id })
    }

    func testChatAlwaysShowsFiveMostRecentAndShowMoreRevealsTheRest() throws {
        let rows = try (0..<9).map { index in
            var value = try session("chat-\(index)")
            value.lastMessageAt = "2026-11-11T00:00:0\(index)Z"
            return SessionRowModel(session: value)
        }
        let chats = ConsoleFlatSessionList.partitionedRows(rows, sort: .name).chats
        let count = ConsoleChatPreviewPolicy.visibleCount(total: chats.count, showsAll: false)
        XCTAssertEqual(chats.prefix(count).map(\.id), ["chat-8", "chat-7", "chat-6", "chat-5", "chat-4"])
        var showsAll = false
        for _ in 0..<3 {
            showsAll.toggle()
            XCTAssertEqual(ConsoleChatPreviewPolicy.visibleCount(total: chats.count, showsAll: showsAll), 9)
            showsAll.toggle()
            XCTAssertEqual(ConsoleChatPreviewPolicy.visibleCount(total: chats.count, showsAll: showsAll), 5)
        }
        XCTAssertEqual(ConsoleChatPreviewPolicy.visibleCount(total: 3, showsAll: false), 3)
        XCTAssertEqual(ConsoleChatPreviewPolicy.visibleCount(total: 0, showsAll: false), 0)
        XCTAssertEqual(ConsoleChatPreviewPolicy.visibleCount(total: 5, showsAll: false), 5)
    }

    func testProjectSubtitleUsesDirectProjectThenTaskBindingAndUnassignedFallback() throws {
        let names = ["work-a": "Project A", "work-b": "Project B"]
        let tasks = ["child-task": "work-b"]
        XCTAssertEqual(ConsoleFlatSessionList.projectName(for: try session("direct", workID: "work-a", taskID: "child-task"),
            workNames: names, taskWorks: tasks), "Project A")
        XCTAssertEqual(ConsoleFlatSessionList.projectName(for: try session("child", taskID: "child-task"),
            workNames: names, taskWorks: tasks), "Project B")
        XCTAssertEqual(ConsoleFlatSessionList.projectName(for: try session("chat"),
            workNames: names, taskWorks: tasks), L10n("未关联项目"))
    }

    func testListReusesNameAndRecentActivityOrderingAndRestoresAsIndependentMode() throws {
        let a = SessionRowModel(session: try session("A"))
        var recent = try session("B")
        recent.lastMessageAt = "2026-11-12T00:00:00Z"
        let b = SessionRowModel(session: recent)
        XCTAssertEqual(ConsoleFlatSessionList.orderedRows([b, a], sort: .name).map(\.id), ["A", "B"])
        XCTAssertEqual(ConsoleFlatSessionList.orderedRows([a, b], sort: .updated).map(\.id), ["B", "A"])
        XCTAssertEqual(ConsoleNavigationMode.resolved("sessionList"), .sessionList)
    }
}
