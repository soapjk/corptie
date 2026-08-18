import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class WorkItemResponseHandlingTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    func testAbsentAcceptanceAssessmentDecodesAsNil() throws {
        let data = Data(
            """
            {
              "workItems": [{
                "id": "work-item:one",
                "objective_id": "objective:one",
                "title": "Keep the data visible",
                "description": "",
                "acceptance_criteria": "",
                "priority": "medium",
                "status": "todo",
                "main_workspace_id": null,
                "main_agent_id": null,
                "current_session_id": null,
                "execution_status": "idle",
                "acceptanceAssessment": null,
                "completionSuggestion": null,
                "created_at": "2026-08-18T00:00:00.000Z",
                "updated_at": "2026-08-18T00:00:00.000Z"
              }]
            }
            """.utf8
        )

        let items = try decoder().decode(WorkItemListEnvelope.self, from: data).workItems
        XCTAssertEqual(items.count, 1)
        XCTAssertNil(items[0].acceptanceAssessment)
    }

    func testMalformedWorkItemResponseProducesExplicitDataSafetyMessage() {
        let data = Data(
            """
            {
              "workItems": [{
                "id": "work-item:legacy",
                "objective_id": "objective:one",
                "title": "Legacy",
                "description": "",
                "acceptance_criteria": "",
                "priority": "medium",
                "status": "todo",
                "acceptanceAssessment": {},
                "created_at": "2026-08-18T00:00:00.000Z",
                "updated_at": "2026-08-18T00:00:00.000Z"
              }]
            }
            """.utf8
        )

        XCTAssertThrowsError(try decoder().decode(WorkItemListEnvelope.self, from: data)) { error in
            let message = EntityAPIClient.workItemsLoadErrorMessage(error)
            XCTAssertTrue(message.contains("WorkItem 加载失败"))
            XCTAssertTrue(message.contains("未用空列表覆盖现有内容"))
            XCTAssertTrue(message.contains("此错误不代表数据已删除"))
            XCTAssertTrue(message.contains("acceptanceAssessment.status"))
        }
    }
}
