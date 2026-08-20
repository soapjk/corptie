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

    func testPassingAcceptanceDecodesWithoutReplacingLifecycleStatus() throws {
        let data = Data(
            """
            {
              "workItems": [{
                "id": "work-item:passed",
                "objective_id": "objective:one",
                "title": "Independent states",
                "description": "",
                "acceptance_criteria": "Tests pass",
                "priority": "medium",
                "status": "in_progress",
                "main_workspace_id": null,
                "main_agent_id": null,
                "current_session_id": "session:one",
                "execution_status": "completed",
                "acceptanceAssessment": {
                  "status": "passed",
                  "criteriaSnapshot": "Tests pass",
                  "sourceSessionId": "session:one",
                  "assessedAt": "2026-08-18T00:00:00.000Z",
                  "results": [{
                    "criterion": "Tests pass",
                    "verdict": "passed",
                    "evidence": [{"summary": "Passed", "reference": "swift test"}]
                  }]
                },
                "completionSuggestion": {
                  "recommended": true,
                  "sourceSessionId": "session:one",
                  "assessedAt": "2026-08-18T00:00:00.000Z",
                  "criteriaSnapshot": "Tests pass",
                  "results": [{
                    "criterion": "Tests pass",
                    "verdict": "passed",
                    "evidence": [{"summary": "Passed", "reference": "swift test"}]
                  }]
                },
                "created_at": "2026-08-18T00:00:00.000Z",
                "updated_at": "2026-08-18T00:00:00.000Z"
              }]
            }
            """.utf8
        )

        let item = try XCTUnwrap(decoder().decode(WorkItemListEnvelope.self, from: data).workItems.first)
        XCTAssertEqual(item.status, "in_progress")
        XCTAssertEqual(item.acceptanceAssessment?.status, "passed")
        XCTAssertEqual(item.completionSuggestion?.recommended, true)
    }

    func testMalformedLegacyAcceptanceAssessmentDoesNotHideTheWorkItem() throws {
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

        let item = try XCTUnwrap(decoder().decode(WorkItemListEnvelope.self, from: data).workItems.first)
        XCTAssertEqual(item.id, "work-item:legacy")
        XCTAssertNil(item.acceptanceAssessment)
    }
}
