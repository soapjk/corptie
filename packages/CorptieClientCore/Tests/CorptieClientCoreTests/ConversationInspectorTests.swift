import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationInspectorTests {
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
