import Foundation
import Testing
@testable import CorptieMac

struct CorptieTaskMemoryPresentationTests {
    @Test func unstartedCorptieTaskDoesNotLoadMemory() {
        #expect(!CorptieTaskMemoryPresentationPolicy.shouldLoad(currentSessionId: nil))
        #expect(!CorptieTaskMemoryPresentationPolicy.shouldLoad(currentSessionId: "  "))
    }

    @Test func startedCorptieTaskLoadsOnlyAfterSessionBindingExists() {
        #expect(CorptieTaskMemoryPresentationPolicy.shouldLoad(currentSessionId: "session:worker"))
    }

    @Test func memoryWireModelDecodesTheExplicitCorptieTaskAssociation() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let memory = try decoder.decode(MemoryItem.self, from: Data("""
        {
          "id": "memory:one",
          "owner_type": "task",
          "owner_id": "task:one",
          "task_id": "task:one",
          "kind": "fact",
          "content": "Actual execution context",
          "source_type": "extracted",
          "created_at": "2026-08-22T00:00:00.000Z"
        }
        """.utf8))

        #expect(memory.ownerId == "task:one")
        #expect(memory.taskId == "task:one")
    }

    @Test func inspectorWireModelDecodesLifecycleProvenanceAndRecallDiagnostics() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let memory = try decoder.decode(MemoryItem.self, from: Data("""
        {
          "id":"memory:audit","ownerType":"agent","ownerId":"agent:one","taskId":null,
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

    @MainActor
    @Test func layeredInspectorDistinguishesUserAgentSystemAndInactiveMemory() throws {
        #expect(MemoryOriginLayer.classify(try memory(source: "user", trust: "trusted", status: "active")) == .userKept)
        #expect(MemoryOriginLayer.classify(try memory(source: "extracted", trust: "untrusted", status: "candidate")) == .agentCandidate)
        #expect(MemoryOriginLayer.classify(try memory(source: "promoted", trust: "trusted", status: "active")) == .agentDurable)
        #expect(MemoryOriginLayer.classify(try memory(source: "pre_compaction", trust: "trusted", status: "active")) == .systemManaged)
        #expect(MemoryOriginLayer.classify(try memory(source: "user", trust: "trusted", status: "active", revokedAt: "2026-08-24T00:00:00Z")) == .inactive)
        #expect(MemoryScopeLayer.allCases.map(\.rawValue) == ["task", "work", "agent"])
    }

    private func memory(
        source: String,
        trust: String,
        status: String,
        revokedAt: String? = nil
    ) throws -> MemoryItem {
        let revoked = revokedAt.map { "\"\($0)\"" } ?? "null"
        let data = Data("""
        {
          "id":"memory:layer","ownerType":"agent","ownerId":"agent:one",
          "kind":"fact","content":"Layered memory","sourceType":"\(source)",
          "promotionStatus":"\(status)","trustLevel":"\(trust)","revokedAt":\(revoked),
          "createdAt":"2026-08-23T00:00:00Z"
        }
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(MemoryItem.self, from: data)
    }
}
