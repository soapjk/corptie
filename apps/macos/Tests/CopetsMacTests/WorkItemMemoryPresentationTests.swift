import Foundation
import Testing
@testable import CorptieMac

struct WorkItemMemoryPresentationTests {
    @Test func unstartedWorkItemDoesNotLoadMemory() {
        #expect(!WorkItemMemoryPresentationPolicy.shouldLoad(currentSessionId: nil))
        #expect(!WorkItemMemoryPresentationPolicy.shouldLoad(currentSessionId: "  "))
    }

    @Test func startedWorkItemLoadsOnlyAfterSessionBindingExists() {
        #expect(WorkItemMemoryPresentationPolicy.shouldLoad(currentSessionId: "session:worker"))
    }

    @Test func memoryWireModelDecodesTheExplicitWorkItemAssociation() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let memory = try decoder.decode(MemoryItem.self, from: Data("""
        {
          "id": "memory:one",
          "owner_type": "work_item",
          "owner_id": "work_item:one",
          "work_item_id": "work_item:one",
          "kind": "fact",
          "content": "Actual execution context",
          "source_type": "extracted",
          "created_at": "2026-08-22T00:00:00.000Z"
        }
        """.utf8))

        #expect(memory.ownerId == "work_item:one")
        #expect(memory.workItemId == "work_item:one")
    }
}
