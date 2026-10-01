import Testing
import Foundation
import CorptieClientCore
@testable import CorptieConversation

struct ConversationInspectorTests {
    @Test func oneDeclaredChoiceSubmitsDirectlyButCompositeFormsDoNot() throws {
        func request(_ questions: String) throws -> ConversationUserInput {
            let json = """
            {"schemaVersion":1,"isBlocking":true,"questions":\(questions)}
            """
            return try JSONDecoder().decode(ConversationUserInput.self, from: Data(json.utf8))
        }
        let single = """
        [{"id":"route","header":"","question":"Route?","isOther":false,"isSecret":false,
          "options":[{"label":"A","description":"Fast"}]}]
        """
        #expect(ConversationUserInputInteractionPolicy.directSelectionQuestionID(try request(single)) == "route")
        let multiple = single.replacingOccurrences(of: "\"isOther\":false", with: "\"selectionMode\":\"multiple\",\"isOther\":false")
        #expect(ConversationUserInputInteractionPolicy.directSelectionQuestionID(try request(multiple)) == nil)
        let twoQuestions = String(single.dropLast()) + "," + String(single.dropFirst())
        #expect(ConversationUserInputInteractionPolicy.directSelectionQuestionID(try request(twoQuestions)) == nil)
    }

    @Test func customAnswerRemainsVisibleBesideAllDeclaredOptions() throws {
        let json = """
        {"schemaVersion":1,"isBlocking":true,"questions":[
          {"id":"route","header":"","question":"Route?","isOther":true,"isSecret":true,
           "options":[{"label":"A","description":"Fast"},{"label":"B","description":"Safe"}]}
        ],"submittedAnswers":{"route":["B","My own route"]}}
        """
        let request = try JSONDecoder().decode(ConversationUserInput.self, from: Data(json.utf8))
        #expect(ConversationInputAnswerPresentation.textAnswers(
            for: request.questions[0], submittedAnswers: request.submittedAnswers) == ["My own route"])
    }

    @Test func textOverflowUsesTheSameToleranceOnBothPlatforms() {
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 60.4, collapsedHeight: 60))
        #expect(CollapsibleDetailTextLayout.isOverflowing(fullHeight: 61, collapsedHeight: 60))
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 40, collapsedHeight: 60))
    }

    @Test func taskDefinitionCardAppearsOnlyWithActualContent() {
        #expect(!ConversationTaskDefinition.hasContent(description: " \n", acceptance: "", verification: "\t"))
        #expect(ConversationTaskDefinition.hasContent(description: "", acceptance: "验收", verification: ""))
        #expect(ConversationTaskDefinition.hasContent(description: "描述", acceptance: "", verification: ""))
    }

    @Test func detailModulesUseGroupedNativeGlassWithoutNestedCardFills() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ConversationInspectorSection.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("GlassEffectContainer(spacing: 0) { content }"))
        #expect(source.contains("let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)"))
        #expect(source.contains(".platformGlassSurface(in: shape)"))
        #expect(source.contains(".clipShape(shape)"))
        #expect(!source.contains(".background(Color.primary.opacity(0.055)"))
    }

    @Test func navigationRailSharesOneGlassCapsuleAcrossPlatforms() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/PlatformNavigationRail.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains(".platformGlassSurface(in: Capsule())"))
        #expect(source.contains(".accessibilityIdentifier(\"navigation-tab-capsule\")"))
        #expect(source.contains(".accessibilityIdentifier(item.accessibilityID)"))
        #expect(source.contains(".accessibilityValue(selected ? \"selected\" : \"not-selected\")"))
    }
}
