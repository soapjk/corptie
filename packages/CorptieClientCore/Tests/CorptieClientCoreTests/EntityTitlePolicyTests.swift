import Foundation
import Testing
@testable import CorptieClientCore

struct EntityTitlePolicyTests {
    @Test func matchesBackendContractCorpusWithoutTrimming() throws {
        struct Example: Decodable { let value: String; let valid: Bool }
        let url = try #require(Bundle.module.url(forResource: "entity-title-policy",
            withExtension: "json", subdirectory: "Fixtures"))
        let examples = try JSONDecoder().decode([Example].self, from: Data(contentsOf: url))
        for example in examples {
            #expect(EntityTitlePolicy.isValid(example.value) == example.valid)
        }
    }

    @Test func generatedDefaultsRemainLegalWithoutChangingExplicitValidation() {
        #expect(EntityTitlePolicy.generatedDefault("123 project") == "_123_project")
        #expect(EntityTitlePolicy.generatedDefault("收益%") == "收益_")
        #expect(EntityTitlePolicy.generatedDefault("🔥") == "Session")
        #expect(!EntityTitlePolicy.isValid("123 project"))
    }
}
