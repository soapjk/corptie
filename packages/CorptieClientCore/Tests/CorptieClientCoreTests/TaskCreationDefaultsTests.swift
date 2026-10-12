import Foundation
import Testing
@testable import CorptieClientCore

struct TaskCreationDefaultsTests {
    @Test func settingsDecodeAndConfigurationRoundTrip() throws {
        let json = #"{"schemaVersion":1,"value":{"providerId":"provider:test","model":"test-model","reasoningLevel":"high"},"defaultProviderId":"provider:default","selectedProviderId":"provider:test","providers":[{"id":"provider:test","name":"Test","available":true,"supportsModels":true,"supportsReasoning":true}],"models":[{"id":"test-model","name":"Test model","reasoningLevels":["low","high"],"defaultReasoningLevel":"low"}],"currentModel":"test-model","currentReasoningLevel":"low","modelError":null}"#
        let value = try JSONDecoder().decode(TaskCreationSettings.self, from: Data(json.utf8))
        #expect(value.schemaVersion == 1)
        #expect(value.providers[0].supportsReasoning)
        #expect(value.models[0].reasoningLevels == ["low", "high"])
        #expect(value.value == TaskCreationDefaults(providerId: "provider:test", model: "test-model", reasoningLevel: "high"))
        let roundTrip = try JSONDecoder().decode(TaskCreationDefaults.self, from: JSONEncoder().encode(value.value))
        #expect(roundTrip == value.value)
    }

    @Test func clearingOverridesUsesEmptyConfigurationNotClientLocalFallback() throws {
        let data = try JSONEncoder().encode(TaskCreationDefaults())
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(object.isEmpty)
    }
}
