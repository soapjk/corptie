import Foundation
import Testing
@testable import CorptieClientCore

struct ClientSkillInstallationTests {
    @Test func receiptsDistinguishAcceptanceFromSuccess() throws {
        for status in ["accepted", "preparing", "prepared", "activating", "succeeded", "failed", "repair_required", "future-state"] {
            let data = Data("{\"operation\":{\"operationId\":\"op:1\",\"requestId\":\"request:1\",\"status\":\"\(status)\",\"updatedAt\":\"now\"}}".utf8)
            let receipt = try JSONDecoder().decode(ClientSkillInstallEnvelope.self, from: data).operation
            #expect(receipt.succeeded == (status == "succeeded"))
            #expect(receipt.isTerminal == ["succeeded", "failed", "repair_required"].contains(status))
        }
    }

    @Test func installationModeIsAdditiveInDeviceSummaries() throws {
        let legacy = try JSONDecoder().decode(ClientControlItem.self, from: Data(#"{"id":"skill:1","name":"Sample"}"#.utf8))
        #expect(legacy.installationMode == nil)
        let managed = try JSONDecoder().decode(ClientControlItem.self, from: Data(#"{"id":"skill:1","name":"Sample","installationMode":"managed","sourceType":"url"}"#.utf8))
        #expect(managed.installationMode == "managed")
        #expect(managed.sourceType == "url")
    }
}
