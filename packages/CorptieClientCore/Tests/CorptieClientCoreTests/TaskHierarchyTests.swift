import Foundation
import Testing
@testable import CorptieClientCore

struct TaskHierarchyTests {
    @Test func oldPayloadAndCreationStayCompatible() throws {
        let task = try JSONDecoder().decode(ClientTask.self, from: Data(#"{"id":"task:old","workId":"work:w","title":"Old","lifecycleState":"todo","executionStatus":"idle","updatedAt":"now"}"#.utf8))
        #expect(task.parentTaskId == nil)
        #expect(task.hierarchy == nil)
        #expect(task.resourceVersion == nil)
        var creation = ClientTaskCreation(requestId: "request_1234", workId: "work:w", title: "Child", mainAgentId: "agent:a", providerId: "neutral")
        let old = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(creation)) as? [String: Any])
        #expect(old["parentTaskId"] == nil)
        #expect(old["expectedParentResourceVersion"] == nil)
        creation.parentTaskId = "task:parent"
        creation.expectedParentResourceVersion = 7
        let child = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(creation)) as? [String: Any])
        #expect(child["parentTaskId"] as? String == "task:parent")
        #expect(child["expectedParentResourceVersion"] as? Int == 7)
    }

    @Test func indexDeduplicatesAncestorsWithoutPromotingOrphansOrTraversingCycles() {
        typealias Node = TaskHierarchyIndex.Node
        let root = Node(id: "p", workId: "w", parentTaskId: nil)
        let child = Node(id: "c", workId: "w", parentTaskId: "p")
        let index = TaskHierarchyIndex(nodes: [child, child,
            Node(id: "orphan", workId: "w", parentTaskId: "unloaded"),
            Node(id: "cross", workId: "other", parentTaskId: "p"),
            Node(id: "grandchild", workId: "w", parentTaskId: "c"),
            Node(id: "loop-a", workId: "w", parentTaskId: "loop-b"),
            Node(id: "loop-b", workId: "w", parentTaskId: "loop-a")], ancestors: [root, root])
        #expect(index.rootIDsByWork["w"] == ["p"])
        #expect(index.childrenByParentID["p"] == ["c"])
        #expect(index.unresolvedParentIDs == ["unloaded"])
        #expect(index.invalidNodeIDs == ["cross", "grandchild", "loop-a", "loop-b"])
    }

    @Test func largeIndexPreservesStableServerOrder() {
        typealias Node = TaskHierarchyIndex.Node
        let roots = (0..<100).map { Node(id: "p\($0)", workId: "w", parentTaskId: nil) }
        let children = (0..<10000).map { Node(id: "c\($0)", workId: "w", parentTaskId: "p\($0 / 100)") }
        let index = TaskHierarchyIndex(nodes: roots + children)
        #expect(index.rootIDsByWork["w"] == roots.map(\.id))
        #expect(index.childrenByParentID["p99"]?.count == 100)
        #expect(index.childrenByParentID["p0"]?.first == "c0")
        #expect(index.invalidNodeIDs.isEmpty)
    }

    @Test func pageUsesExplicitSurfaceAndScope() async throws {
        for surface in [ClientTaskHierarchyAPI.Surface.local, .pairedDevice] {
            let endpoint = try BackendEndpoint(URL(string: "https://unit-test.invalid")!)
            let transport = BackendTransport(endpoint: endpoint, data: { request in
                let url = try #require(request.url)
                #expect(url.path == (surface == .local ? "/works/work:w/task-hierarchy" : "/client/v1/works/work:w/task-hierarchy"))
                let query = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
                #expect(query.first(where: { $0.name == "parentTaskId" })?.value == "task:p")
                #expect(query.first(where: { $0.name == "q" })?.value == "中 文&x")
                let data = Data(#"{"schemaVersion":1,"scope":{"workId":"work:w","mode":"search","parentTaskId":"task:p","queryHash":"hash"},"tasks":[],"ancestors":[],"hasMore":false,"nextCursor":null}"#.utf8)
                return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            let page = try await ClientTaskHierarchyAPI(transport: transport, surface: surface).page(workID: "work:w", parentTaskID: "task:p", query: "中 文&x")
            #expect(page.scope.mode == "search")
            #expect(page.taskHierarchyCapabilities == nil)
        }
    }
}
