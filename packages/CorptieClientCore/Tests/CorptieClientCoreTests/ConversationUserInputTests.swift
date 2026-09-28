import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationUserInputTests {
    @Test func completedInputRetainsOnlyDeclaredSelectionProjection() throws {
        let json = """
        {"schemaVersion":1,"isBlocking":true,"selectedOptions":{"route":["B"]},
         "submittedAnswers":{"route":["B"]},"questions":[
          {"id":"route","header":"Route","question":"Choose route","isOther":false,
           "isSecret":false,"selectionMode":"single","options":[{"label":"A","description":"Fast"},{"label":"B","description":"Safe"}]}
        ]}
        """
        let input = try JSONDecoder().decode(ConversationUserInput.self, from: Data(json.utf8))
        #expect(input.selectedOptions == ["route": ["B"]])
        #expect(input.submittedAnswers == ["route": ["B"]])
        #expect(input.questions[0].options?.map(\.label) == ["A", "B"])
    }

    @Test func singleMultipleOptionalAndCustomAnswersUseTheSameRules() throws {
        let json = """
        {"schemaVersion":1,"kind":"question","responseMode":"message","isBlocking":false,"canCancel":true,"questions":[
          {"id":"single","header":"","question":"One","isOther":true,"isSecret":false,"selectionMode":"single","options":[{"label":"A","description":""},{"label":"B","description":""}]},
          {"id":"multi","header":"","question":"Many","isOther":true,"isSecret":false,"selectionMode":"multiple","options":[{"label":"A","description":""},{"label":"B","description":""}]},
          {"id":"optional","header":"","question":"Optional","isOther":false,"isSecret":false,"required":false}
        ]}
        """
        let input = try JSONDecoder().decode(ConversationUserInput.self, from: Data(json.utf8))
        #expect(input.canCancel == true)
        #expect(input.answers(selected: ["single": ["A", "B"], "multi": ["A"]], typed: [:]) == nil)
        #expect(input.answers(selected: ["single": ["A"], "multi": ["A", "B"]], typed: ["single": "Custom"])
                == ["single": ["Custom"], "multi": ["A", "B"], "optional": []])
    }
}
