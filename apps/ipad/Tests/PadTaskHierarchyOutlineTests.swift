import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor struct PadTaskHierarchyOutlineTests {
    private func task(_ id: String = "parent", parent: String? = nil) throws -> ClientTask {
        try JSONDecoder().decode(ClientTask.self, from: Data("""
        {"id":"\(id)","title":"\(id)","workId":"work","lifecycleState":"in_progress",
         "executionStatus":"completed","updatedAt":"now","resourceVersion":1,
         "parentTaskId":\(parent.map { "\"\($0)\"" } ?? "null")}
        """.utf8))
    }

    @Test func projectionKeepsChildrenAndFooterInsideTheParentSubtree() throws {
        let parent = try task()
        let child1 = try task("child1", parent: parent.id)
        let child2 = try task("child2", parent: parent.id)
        let plain = try task("plain")
        let items = [child1, parent, plain, child2]
        let open = PadTaskOutlineHierarchy(filtered: items, inventory: items, expanded: [parent.id], searching: false)
        #expect(open.tasks.map(\.id) == ["parent", "child1", "child2", "plain"])
        #expect(open.childCountByParent[parent.id] == 2)
        #expect(open.footerParentByRowID == ["child2": parent.id])
        let closed = PadTaskOutlineHierarchy(filtered: items, inventory: items, expanded: [], searching: false)
        #expect(closed.tasks.map(\.id) == ["parent", "plain"])
        #expect(closed.footerParentByRowID.isEmpty)
    }

    @Test func searchOrArchiveFilteringRestoresParentContextWithoutUnrelatedChildren() throws {
        let parent = try task()
        let child = try task("match", parent: parent.id)
        let unrelated = try task("other", parent: parent.id)
        let projection = PadTaskOutlineHierarchy(filtered: [child], inventory: [parent, unrelated, child], expanded: [], searching: true)
        #expect(projection.tasks.map(\.id) == [parent.id, child.id])
        #expect(projection.footerParentByRowID == [child.id: parent.id])
    }

    private func fixture(_ probe: HierarchyOutlineProbe) throws -> (PadWorkspace, PadConnection, ClientTask) {
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { request in try await probe.read(request) }, bytes: { _ in throw URLError(.unsupportedURL) })
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = "server"
        let workspace = PadWorkspace()
        let parent = try task()
        workspace.tasks = [parent]
        return (workspace, connection, parent)
    }

    @Test func loadingIsCoalescedAndOldScopeResponseCannotChangeTheNewInventory() async throws {
        let probe = HierarchyOutlineProbe()
        await probe.hold()
        let (workspace, connection, parent) = try fixture(probe)
        let pending = Task { await workspace.loadTaskChildren(parent, connection: connection) }
        await probe.waitForRead()
        #expect(workspace.taskChildrenLoading.contains(parent.id))
        await workspace.loadTaskChildren(parent, connection: connection, force: true)
        #expect(await probe.count == 1)
        connection.serverID = "other"
        workspace.prepareTaskChildrenScope(connection)
        await probe.release()
        await pending.value
        #expect(workspace.tasks.map(\.id) == [parent.id])
        #expect(workspace.taskChildrenLoading.isEmpty)
        #expect(workspace.taskChildrenCursors.isEmpty)
    }

    @Test func failureIsInlineAndRetryDoesNotLeaveTheParentStuckLoading() async throws {
        let probe = HierarchyOutlineProbe()
        await probe.failNext()
        let (workspace, connection, parent) = try fixture(probe)
        await workspace.loadTaskChildren(parent, connection: connection)
        #expect(workspace.taskChildrenErrors[parent.id] != nil)
        #expect(workspace.taskChildrenLoading.isEmpty)
        #expect(connection.notice.isEmpty)
        await workspace.loadTaskChildren(parent, connection: connection, force: true)
        #expect(workspace.taskChildrenErrors[parent.id] == nil)
        #expect(workspace.tasks.map(\.id) == [parent.id, "child1"])
    }

    @Test func inventoryReplacementInvalidatesTheLoadedChildrenCache() async throws {
        let probe = HierarchyOutlineProbe()
        let (workspace, connection, parent) = try fixture(probe)
        await workspace.loadTaskChildren(parent, connection: connection)
        workspace.tasks = [parent]
        await workspace.loadTaskChildren(parent, connection: connection)
        #expect(await probe.count == 2)
        #expect(workspace.tasks.map(\.id) == [parent.id, "child1"])
    }

    @Test func reopeningAnUnchangedParentDoesNotRepeatTheFirstPage() async throws {
        let probe = HierarchyOutlineProbe()
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { request in try await probe.read(request) }, bytes: { _ in throw URLError(.unsupportedURL) })
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = "server"
        let workspace = PadWorkspace()
        let parent = try task()
        workspace.tasks = [parent]
        await workspace.loadTaskChildren(parent, connection: connection)
        await workspace.loadTaskChildren(parent, connection: connection)
        #expect(await probe.count == 1)
        #expect(workspace.tasks.map(\.id) == ["parent", "child1"])
        await workspace.loadTaskChildren(parent, connection: connection, more: true)
        #expect(await probe.count == 2)
        #expect(workspace.tasks.map(\.id) == ["parent", "child1", "child2"])
        #expect(workspace.taskChildrenCursors[parent.id] == nil)
    }
}

private actor HierarchyOutlineProbe {
    private(set) var count = 0
    private var shouldFail = false
    private var held = false
    private var readWaiter: CheckedContinuation<Void, Never>?
    private var startWaiter: CheckedContinuation<Void, Never>?
    func failNext() { shouldFail = true }
    func hold() { held = true }
    func waitForRead() async {
        if count > 0 { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func release() { held = false; readWaiter?.resume(); readWaiter = nil }
    func read(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        count += 1
        startWaiter?.resume(); startWaiter = nil
        if held { await withCheckedContinuation { readWaiter = $0 } }
        if shouldFail { shouldFail = false; throw ClientConnectionError.httpStatus(503) }
        let more = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .contains { $0.name == "cursor" } == true
        let child = more ? "child2" : "child1"
        let cursor = more ? "null" : "\"next\""
        let body = """
        {"schemaVersion":1,"scope":{"workId":"work","mode":"children","parentTaskId":"parent","queryHash":"q"},
        "tasks":[{"id":"\(child)","title":"\(child)","parentTaskId":"parent","workId":"work",
        "lifecycleState":"in_progress","executionStatus":"completed","updatedAt":"now"}],
        "ancestors":[],"hasMore":\(!more),"nextCursor":\(cursor)}
        """
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
