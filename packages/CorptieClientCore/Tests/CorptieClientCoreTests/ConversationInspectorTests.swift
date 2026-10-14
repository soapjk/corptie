import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationInspectorTests {
    @Test func logicalAliasesAreExactAmbiguityFailsClosedAndOlderInventoryStillDecodes() throws {
        let aliases = ClientDetailNavigationPolicy.sessionAliases([(id: "legacy-a", logicalID: "logical:a"),
            (id: "legacy-b", logicalID: "logical:b"), (id: "legacy-c", logicalID: "logical:b"), (id: "old", logicalID: nil)])
        #expect(aliases["logical:a"] == "legacy-a")
        #expect(aliases["logical:b"] == nil)
        let base = #"{"id":"legacy-a","title":"S","executionStatus":"idle","updatedAt":"now"}"#
        #expect(try JSONDecoder().decode(ClientSession.self, from: Data(base.utf8)).logicalSessionId == nil)
        let current = base.replacingOccurrences(of: "\"title\":", with: "\"logicalSessionId\":\"logical:a\",\"title\":")
        #expect(try JSONDecoder().decode(ClientSession.self, from: Data(current.utf8)).logicalSessionId == "logical:a")
        #expect(!ClientDetailNavigationPolicy.permitsSession(targetID: "exact", sourceWorkID: "w", destinationWorkID: "w",
            destinationTaskID: "new-task", taskID: "new-task", taskWorkID: "w", taskCurrentSessionID: "exact", expectedTaskID: "original-task"))
    }
    @Test func exactSessionNavigationRejectsRebindingAndForeignOrRetiredDestinations() {
        func permits(_ current: String?, work: String? = "w", retired: Bool = false, task: String? = "t") -> Bool {
            ClientDetailNavigationPolicy.permitsSession(targetID: "exact", sourceWorkID: "w",
                destinationWorkID: work, destinationTaskID: "t", taskID: task, taskWorkID: "w",
                taskCurrentSessionID: current, retired: retired)
        }
        #expect(permits("exact"))
        #expect(!permits("replacement"))
        #expect(!permits(nil))
        #expect(!permits("exact", work: "foreign"))
        #expect(!permits("exact", retired: true))
        #expect(!permits("exact", task: "other"))
        #expect(!ClientDetailNavigationPolicy.permitsSession(targetID: "exact", sourceWorkID: nil,
            destinationWorkID: nil, destinationTaskID: nil, taskID: nil, taskWorkID: nil, taskCurrentSessionID: nil))
    }
    @Test func residentResourceSelectionRequiresCurrentUnambiguousNonErrorSection() throws {
        func snapshot(_ sections: [String: ClientInspectorValue], _ errors: [String: String] = [:]) -> ClientInspectorSnapshot {
            .init(schemaVersion: 1, sessionId: "s", resolvedSessionId: "s", workId: nil, taskId: nil,
                taskDefinition: nil, workDescription: nil, summary: nil, environment: .object([:]), sections: sections, errors: errors)
        }
        let memory = ClientInspectorValue.object(["id": .string("memory:ours"), "content": .string("Current")])
        let section = ClientInspectorValue.object(["items": .array([memory])])
        let current = snapshot(["memories": section])
        #expect(current.residentDetailResource(kind: "memory", id: "memory:ours") == memory)
        #expect(current.residentDetailResource(kind: "memory", id: "memory:foreign") == nil)
        #expect(snapshot([:]).residentDetailResource(kind: "memory", id: "memory:ours") == nil)
        #expect(snapshot(["memories": section], ["memories": "DENIED"]).residentDetailResource(kind: "memory", id: "memory:ours") == nil)
        #expect(snapshot(["memories": .object(["items": .array([memory, memory])])]).residentDetailResource(kind: "memory", id: "memory:ours") == nil)
        #expect(current.residentDetailResource(kind: "unregistered", id: "memory:ours") == nil)
        let artifact = ClientInspectorValue.object(["artifactId": .string("artifact:ours"), "currentVersion": .number(4)])
        #expect(snapshot(["artifacts": .object(["items": .array([artifact])])]).residentDetailResource(kind: "artifact", id: "artifact:ours") == artifact)
        let reference = ClientInspectorValue.object(["referenceId": .string("reference:ours")])
        #expect(snapshot(["references": .array([reference])]).residentDetailResource(kind: "reference", id: "reference:ours") == reference)
    }
    @Test func sharedVersionSelectionAndNanosecondDurations() {
        #expect(ConversationInspectorPolicy.preferredArtifactVersion(pinned: 2, approved: 4, current: 5) == 2)
        #expect(ConversationInspectorPolicy.preferredArtifactVersion(pinned: nil, approved: 4, current: 5) == 4)
        #expect(ConversationInspectorPolicy.preferredArtifactVersion(pinned: nil, approved: nil, current: 5) == 5)
        #expect(ConversationInspectorPolicy.spanDurationMilliseconds(start: "1750000000000000000", end: "1750000000000123456") == 0.123456)
    }
    @Test func inspectorSectionsPreserveUnknownFieldsAndIndependentErrors() throws {
        let json = #"{"schemaVersion":1,"sessionId":"s","resolvedSessionId":"provider:s","workId":null,"taskId":null,"taskDefinition":null,"workDescription":null,"summary":null,"environment":{},"sections":{"references":[],"future":{"value":true}},"errors":{"artifacts":"FAILED"}}"#
        let snapshot = try JSONDecoder().decode(ClientInspectorSnapshot.self, from: Data(json.utf8))
        #expect(snapshot.sections["future"]?["value"].flag == true)
        #expect(snapshot.sections["artifacts"] == nil)
        #expect(snapshot.errors["artifacts"] == "FAILED")
    }
    @Test func explicitSessionKindControlsDetailsWithoutInferringAnExecutorFromResources() {
        #expect(ConversationInspectorKind.resolve(sessionKind: "assistantChat", taskID: "t", workID: "w") == .chat)
        #expect(ConversationInspectorKind.resolve(sessionKind: "workChat", taskID: nil, workID: "w") == .work)
        #expect(ConversationInspectorKind.resolve(sessionKind: "worker", taskID: "t", workID: "w") == .task)
        #expect(ConversationInspectorKind.resolve(sessionKind: nil, taskID: "t", workID: "w") == .legacy)
    }
    @Test func olderHostsRemainDecodableAndPushedDefinitionChangesAreObservable() throws {
        let old = #"{"id":"t","title":"Task","workId":"w","lifecycleState":"todo","executionStatus":"idle","updatedAt":"now"}"#
        let decoder = JSONDecoder()
        let original = try decoder.decode(ClientTask.self, from: Data(old.utf8))
        #expect(original.description == nil)
        let updated = old.replacingOccurrences(of: "\"title\":\"Task\"", with: "\"title\":\"Task\",\"description\":\"Full definition\",\"acceptanceCriteria\":\"Acceptance\",\"verificationCriteria\":\"Verification\"")
        let next = try decoder.decode(ClientTask.self, from: Data(updated.utf8))
        #expect(next != original)
        #expect(next.acceptanceCriteria == "Acceptance")
        #expect(next.verificationCriteria == "Verification")
    }
}
