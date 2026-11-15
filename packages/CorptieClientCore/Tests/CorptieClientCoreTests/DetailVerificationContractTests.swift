import Foundation
import XCTest
@testable import CorptieClientCore

final class DetailVerificationContractTests: XCTestCase {
    private func document(actionChanges: [String: Any] = [:], verificationChanges: [String: Any] = [:],
                          includeVerification: Bool = true, includeAction: Bool = true,
                          wrongCard: Bool = false) throws -> Data {
        var verification: [String: Any] = ["sessionId": "logical:test", "available": true,
            "policyEditable": true, "revision": "0:0:0:0", "policy": ["enabled": false, "limit": 3, "revision": 0],
            "budgets": [], "limitation": ""]
        verification.merge(verificationChanges) { _, next in next }
        var action: [String: Any] = ["id": "verification-control", "kind": "command", "operation": "verification.control",
            "label": ["fallback": "管理验证预算"], "available": true,
            "target": ["resourceType": "session", "id": "logical:test"], "expectedResourceRevision": "0:0:0:0"]
        action.merge(actionChanges) { _, next in next }
        var payload: [String: Any] = ["completeness": "complete", "wall": [:], "wallPartition": [:], "inclusive": [:]]
        if includeVerification { payload["verification"] = verification }
        if wrongCard {
            payload = ["providerId": "test", "name": "Test", "model": "test", "reasoning": "medium",
                       "switching": false, "providers": []]
        }
        let card: [String: Any] = ["id": "business-turn", "kind": wrongCard ? "provider" : "turnMetrics",
            "version": 1, "revision": "r1", "loadState": "ready", "data": payload,
            "actions": includeAction ? [action] : []]
        return try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "catalog": "native-business-v1",
            "documentId": "document:test", "sessionId": "logical:test", "generation": "g1", "revision": "r1",
            "cards": [card], "order": ["business-turn"]])
    }

    func testBudgetControlLoadsInFullBusinessDocument() throws {
        let value = try ClientDetailBusinessDocument.decode(document())
        XCTAssertEqual(value.cards.first?.actions.first?.operation, "verification.control")
        XCTAssertNoThrow(try ClientDetailBusinessDocument.decode(document(verificationChanges: ["policyEditable": false])))
        XCTAssertNoThrow(try ClientDetailBusinessDocument.decode(document(includeVerification: false, includeAction: false)))
    }

    func testControlRejectsWrongScopeRevisionAvailabilityAndCard() throws {
        let invalid: [Data] = try [
            document(actionChanges: ["target": ["resourceType": "session", "id": "logical:other"]]),
            document(verificationChanges: ["sessionId": "logical:other"]),
            document(actionChanges: ["target": ["resourceType": "task", "id": "logical:test"]]),
            document(actionChanges: ["expectedResourceRevision": "stale"]),
            document(actionChanges: ["expectedResourceRevision": NSNull()]),
            document(actionChanges: ["expectedResourceRevision": ""], verificationChanges: ["revision": ""]),
            document(verificationChanges: ["available": false]),
            document(includeVerification: false), document(wrongCard: true),
            document(actionChanges: ["kind": "navigation"]),
            document(actionChanges: ["operation": "verification.unknown"])
        ]
        for data in invalid {
            XCTAssertThrowsError(try ClientDetailBusinessDocument.decode(data)) {
                XCTAssertEqual($0 as? ClientDetailFailure, .invalidGraph)
            }
        }
    }
}
