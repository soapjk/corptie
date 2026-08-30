import CryptoKit
import Foundation
import Testing
@testable import CorptieMac

struct StartupBindingReceiptTests {
    @Test func decodesAndVerifiesCompleteSchemaV2Receipt() throws {
        let payload = try readyPayload()
        let decoded = try JSONDecoder().decode(WorkItemStartupReady.self, from: payload)

        #expect(decoded.status == "ready")
        #expect(decoded.receipt.schemaVersion == 2)
        #expect(decoded.receipt.bindingGeneration == 1)
        #expect(decoded.receipt.hasValidHash())
    }

    @Test func rejectsUnknownRequiredEnumInsteadOfDisplayingReady() throws {
        var envelope = try readyObject()
        var receipt = try #require(envelope["receipt"] as? [String: Any])
        receipt["headIdentity"] = ["kind": "future_kind", "branch": "workitem/one"]
        receipt["receiptHash"] = try hash(receipt)
        envelope["receipt"] = receipt

        let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .withoutEscapingSlashes])
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(WorkItemStartupReady.self, from: data)
        }
    }

    @Test func rejectsMissingRequiredIdentityAndInvalidReceiptHash() throws {
        var missing = try readyObject()
        var missingReceipt = try #require(missing["receipt"] as? [String: Any])
        missingReceipt.removeValue(forKey: "sourceTreeOid")
        missingReceipt["receiptHash"] = try hash(missingReceipt)
        missing["receipt"] = missingReceipt
        let missingData = try JSONSerialization.data(withJSONObject: missing)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(WorkItemStartupReady.self, from: missingData)
        }

        var invalid = try readyObject()
        var invalidReceipt = try #require(invalid["receipt"] as? [String: Any])
        invalidReceipt["receiptHash"] = String(repeating: "0", count: 64)
        invalid["receipt"] = invalidReceipt
        let invalidData = try JSONSerialization.data(withJSONObject: invalid)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(WorkItemStartupReady.self, from: invalidData)
        }
    }

    @Test func rejectsUnknownReceiptAndNestedFieldsFailClosed() throws {
        var topLevel = try readyObject()
        var topReceipt = try #require(topLevel["receipt"] as? [String: Any])
        topReceipt["futureRequiredIdentity"] = "future:value"
        topReceipt["receiptHash"] = try hash(topReceipt)
        topLevel["receipt"] = topReceipt
        let topData = try JSONSerialization.data(withJSONObject: topLevel)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(WorkItemStartupReady.self, from: topData)
        }

        var nested = try readyObject()
        var nestedReceipt = try #require(nested["receipt"] as? [String: Any])
        var timestamps = try #require(nestedReceipt["phaseTimestamps"] as? [String: Any])
        timestamps["futurePhase"] = "2026-08-30T00:00:00.050Z"
        nestedReceipt["phaseTimestamps"] = timestamps
        nestedReceipt["receiptHash"] = try hash(nestedReceipt)
        nested["receipt"] = nestedReceipt
        let nestedData = try JSONSerialization.data(withJSONObject: nested)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(WorkItemStartupReady.self, from: nestedData)
        }
    }

    private func readyPayload() throws -> Data {
        try JSONSerialization.data(withJSONObject: readyObject(), options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func readyObject() throws -> [String: Any] {
        var receipt: [String: Any] = [
            "schemaVersion": 2,
            "status": "ready",
            "startupOperationId": "startup:one",
            "objectiveId": "objective:one",
            "workItemId": "work_item:one",
            "logicalSessionId": "session:one",
            "repositoryId": "repository:one",
            "worktreeId": "worktree:one",
            "canonicalWorktreePath": "/Volumes/T9/worktrees/one",
            "headIdentity": ["kind": "branch", "branch": "workitem/one"],
            "providerBindingId": "startup-binding:one",
            "bindingGeneration": 1,
            "sourceCommitOid": String(repeating: "a", count: 40),
            "sourceTreeOid": String(repeating: "b", count: 40),
            "baseRef": NSNull(),
            "repositoryInventoryVersion": "inventory:one",
            "workspaceResourceVersion": 1,
            "resourceVersion": 5,
            "providerContextHash": String(repeating: "c", count: 64),
            "phaseTimestamps": [
                "allocatedAt": "2026-08-30T00:00:00.000Z",
                "worktreePreparedAt": "2026-08-30T00:00:00.010Z",
                "sessionBoundAt": "2026-08-30T00:00:00.020Z",
                "providerBoundAt": "2026-08-30T00:00:00.030Z",
                "readyAt": "2026-08-30T00:00:00.040Z"
            ],
            "compensation": [
                "attempted": false,
                "result": "not_required",
                "completedSteps": [],
                "failedStep": NSNull()
            ],
            "error": NSNull()
        ]
        receipt["receiptHash"] = try hash(receipt)
        return ["status": "ready", "idempotentReplay": false, "receipt": receipt]
    }

    private func hash(_ receipt: [String: Any]) throws -> String {
        var unsigned = receipt
        unsigned.removeValue(forKey: "receiptHash")
        let data = try JSONSerialization.data(withJSONObject: unsigned, options: [.sortedKeys, .withoutEscapingSlashes])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
