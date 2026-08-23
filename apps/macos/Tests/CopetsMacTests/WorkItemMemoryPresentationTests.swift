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

    @Test func inspectorWireModelDecodesLifecycleProvenanceAndRecallDiagnostics() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let memory = try decoder.decode(MemoryItem.self, from: Data("""
        {
          "id":"memory:audit","ownerType":"agent","ownerId":"agent:one","workItemId":null,
          "kind":"procedure","content":"Use the shared contract","sourceType":"user",
          "sourceSessionId":"session:one","sourceEventSeqs":[3],"tags":["provider-neutral"],
          "confidence":0.91,"usageCount":4,"lastAccessedAt":"2026-08-23T01:00:00Z",
          "promotionStatus":"promoted_to_skill","promotedSkillId":"skill:one","trustLevel":"trusted",
          "expiresAt":null,"replacesMemoryId":null,"version":2,"autoApplied":false,
          "appliedAt":"2026-08-23T00:00:00Z","revokedAt":null,
          "createdAt":"2026-08-22T00:00:00Z","updatedAt":"2026-08-23T00:00:00Z"
        }
        """.utf8))
        #expect(memory.tags == ["provider-neutral"])
        #expect(memory.usageCount == 4)
        #expect(memory.trustLevel == "trusted")
        #expect(memory.promotedSkillId == "skill:one")

        let recall = try decoder.decode(MemoryRecallAudit.self, from: Data("""
        {"id":"memory-recall:1","sessionId":"session:one","phase":"turn","mode":"lightweight",
         "reason":"task_context_cue","candidateIds":["memory:audit"],"selectedIds":["memory:audit"],
         "createdAt":"2026-08-23T00:00:00Z"}
        """.utf8))
        #expect(recall.mode == "lightweight")
        #expect(recall.selectedIds.count == 1)
    }
}
