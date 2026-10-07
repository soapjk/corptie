import Testing
import CorptieClientCore
@testable import CorptieConversation

struct ConversationTurnTimeBreakdownTests {
    @Test func decodesInspectorContractWithoutInventingCategories() {
        let value: ClientInspectorValue = .object([
            "schemaVersion": .number(1), "policyVersion": .string("wall-partition-v1"), "totalMs": .number(100),
            "categories": .array([
                .object(["id": .string("model"), "durationMs": .number(30)]),
                .object(["id": .string("overlap"), "durationMs": .number(50)]),
                .object(["id": .string("unattributed"), "durationMs": .number(20)])
            ]), "toolOperations": .array([])
        ])
        let breakdown = ConversationTurnTimeBreakdown(inspectorValue: value)
        #expect(breakdown?.totalMs == 100)
        #expect(breakdown?.categories.map(\.id) == ["model", "overlap", "unattributed"])
        #expect(breakdown?.toolOperations.isEmpty == true)
        #expect(ConversationTurnTimeBreakdown(inspectorValue: .null) == nil)
    }
}
