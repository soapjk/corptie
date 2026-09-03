import XCTest
@testable import CorptieMac

final class AssistFormDraftTests: XCTestCase {
    func testOverwritePolicyIgnoresDefaultsButProtectsUserContent() {
        XCTAssertFalse(
            FormAssistOverwritePolicy.hasMeaningfulExistingContent(
                formType: .agent,
                values: ["name": "", "description": "", "role": "independentContributor"]
            )
        )
        XCTAssertFalse(
            FormAssistOverwritePolicy.hasMeaningfulExistingContent(
                formType: .task,
                values: ["title": "", "description": "", "priority": "medium"]
            )
        )
        XCTAssertTrue(
            FormAssistOverwritePolicy.hasMeaningfulExistingContent(
                formType: .work,
                values: ["name": "现有目标", "description": ""]
            )
        )
        XCTAssertTrue(
            FormAssistOverwritePolicy.hasMeaningfulExistingContent(
                formType: .task,
                values: ["title": "", "description": "", "priority": "high"]
            )
        )
    }

    func testDetectsEditsMadeWhileGeneratingOrAfterApplying() {
        let snapshot = ["title": "原始标题", "description": "原始描述"]
        XCTAssertFalse(FormAssistOverwritePolicy.formChanged(since: snapshot, current: snapshot))
        XCTAssertTrue(
            FormAssistOverwritePolicy.formChanged(
                since: snapshot,
                current: ["title": "用户新标题", "description": "原始描述"]
            )
        )
    }

    func testDecodesCompleteAgentAndWorkDrafts() throws {
        let agentData = Data(#"""
        {
          "formType": "agent",
          "fields": {
            "name": "SwiftUI Agent",
            "description": "负责 macOS 客户端体验。",
            "role": "independentContributor",
            "systemPrompt": "实现变更并运行测试。",
            "capabilities": "swiftui, testing"
          }
        }
        """#.utf8)
        let workData = Data(#"""
        {
          "formType": "work",
          "fields": {
            "name": "统一创建页辅助填写",
            "description": "统一三个实体创建页的生成体验。",
            "idealState": "创建体验持续一致，草稿始终可检查、可编辑。",
            "priority": "high",
            "tags": "macos, forms"
          }
        }
        """#.utf8)

        let agentDraft = try JSONDecoder().decode(AssistFormDraft.self, from: agentData)
        let workDraft = try JSONDecoder().decode(AssistFormDraft.self, from: workData)

        XCTAssertEqual(agentDraft.formType, AssistFormType.agent.rawValue)
        XCTAssertEqual(agentDraft.fields["role"], "independentContributor")
        XCTAssertEqual(workDraft.formType, AssistFormType.work.rawValue)
        XCTAssertNil(workDraft.fields["targetDate"])
    }

    func testDecodesCompleteCorptieTaskDraft() throws {
        let data = Data(#"""
        {
          "formType": "task",
          "fields": {
            "title": "统一帮我写",
            "description": "一次填写所有字段。",
            "acceptanceCriteria": "- 可检查\n- 可编辑",
            "priority": "high"
          },
          "providerId": "test-provider"
        }
        """#.utf8)

        let draft = try JSONDecoder().decode(AssistFormDraft.self, from: data)
        XCTAssertEqual(draft.formType, AssistFormType.task.rawValue)
        XCTAssertEqual(draft.fields["title"], "统一帮我写")
        XCTAssertEqual(draft.providerId, "test-provider")
    }

    func testRejectsUnknownOrMissingGeneratedFields() {
        let data = Data(#"""
        {
          "formType": "agent",
          "fields": {
            "name": "后端 Agent",
            "description": "负责接口",
            "role": "independentContributor",
            "systemPrompt": "维护后端。",
            "unexpected": "must fail"
          }
        }
        """#.utf8)

        XCTAssertThrowsError(try JSONDecoder().decode(AssistFormDraft.self, from: data))
    }
}
