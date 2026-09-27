import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationUserInputTests {
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
