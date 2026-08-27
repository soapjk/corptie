import XCTest
@testable import CorptieMac

final class NewSessionModelSelectionTests: XCTestCase {
    private let models = [
        CodexModel(
            id: "gpt-5.6-sol",
            name: "GPT-5.6",
            description: nil,
            defaultReasoningLevel: "low",
            reasoningLevels: ["low", "medium", "high", "xhigh"],
            serviceTiers: nil
        )
    ]

    func testSavedModelAndReasoningWinOverProviderDefaults() {
        XCTAssertEqual(
            NewSessionModelSelection.preferredModelId(
                savedModelId: "gpt-5.6-sol",
                providerDefaultModelId: "other-model",
                models: models
            ),
            "gpt-5.6-sol"
        )
        XCTAssertEqual(
            NewSessionModelSelection.preferredReasoningLevel(
                savedReasoningLevel: "xhigh",
                providerDefaultReasoningLevel: "high",
                model: models[0]
            ),
            "xhigh"
        )
    }

    func testProviderReasoningWinsOverModelMetadataDefaultWhenNoSavedDefaultExists() {
        XCTAssertEqual(
            NewSessionModelSelection.preferredReasoningLevel(
                savedReasoningLevel: nil,
                providerDefaultReasoningLevel: "xhigh",
                model: models[0]
            ),
            "xhigh"
        )
    }

    func testUnsupportedReasoningFallsBackToModelDefault() {
        XCTAssertEqual(
            NewSessionModelSelection.preferredReasoningLevel(
                savedReasoningLevel: "unsupported",
                providerDefaultReasoningLevel: nil,
                model: models[0]
            ),
            "low"
        )
    }

    func testComposerMenuExposesOnlyCurrentModelsReasoningLevelsAndSelectedSessionValue() {
        let other = CodexModel(
            id: "other", name: "Other", description: nil,
            defaultReasoningLevel: "medium", reasoningLevels: ["low", "medium"],
            serviceTiers: nil
        )

        XCTAssertEqual(
            SessionReasoningSelection.availableLevels(
                modelID: models[0].id,
                models: [other] + models,
                supportsSwitch: true
            ),
            ["low", "medium", "high", "xhigh"]
        )
        XCTAssertEqual(
            SessionReasoningSelection.currentLevel(
                sessionLevel: "xhigh",
                providerDefaultLevel: "medium",
                model: models[0]
            ),
            "xhigh"
        )
        XCTAssertTrue(SessionReasoningSelection.availableLevels(
            modelID: models[0].id,
            models: models,
            supportsSwitch: false
        ).isEmpty)
    }
}
