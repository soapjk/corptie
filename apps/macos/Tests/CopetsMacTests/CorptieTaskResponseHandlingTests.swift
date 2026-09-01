import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class CorptieTaskResponseHandlingTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    func testAbsentAcceptanceAssessmentDecodesAsNil() throws {
        let data = Data(
            """
            {
              "tasks": [{
                "id": "task:one",
                "objective_id": "objective:one",
                "title": "Keep the data visible",
                "description": "",
                "goal": "",
                "acceptance_criteria": "",
                "verification_criteria": "",
                "priority": "medium",
                "lifecycle_state": "todo",
                "resource_version": 1,
                "revision": 1,
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

        let items = try decoder().decode(CorptieTaskListEnvelope.self, from: data).tasks
        XCTAssertEqual(items.count, 1)
        XCTAssertNil(items[0].acceptanceAssessment)
    }

    func testStartupFailureUsesOnlyCorptieTaskLifecycleProjection() throws {
        let data = Data(
            """
            {
              "tasks": [{
                "id": "task:partial",
                "objective_id": "objective:one",
                "title": "Partial start",
                "description": "",
                "goal": "",
                "acceptance_criteria": "",
                "verification_criteria": "",
                "priority": "medium",
                "lifecycle_state": "todo",
                "resource_version": 1,
                "revision": 1,
                "main_workspace_id": "repository:one",
                "main_agent_id": "agent:one",
                "current_session_id": null,
                "execution_status": "start_failed",
                "created_at": "2026-08-23T00:00:00.000Z",
                "updated_at": "2026-08-23T00:01:00.000Z"
              }]
            }
            """.utf8
        )

        let item = try XCTUnwrap(decoder().decode(CorptieTaskListEnvelope.self, from: data).tasks.first)
        XCTAssertEqual(item.executionStatus, "start_failed")
        XCTAssertNil(item.currentSessionId)
    }

    func testPassingAcceptanceDecodesWithoutReplacingLifecycleStatus() throws {
        let data = Data(
            """
            {
              "tasks": [{
                "id": "task:passed",
                "objective_id": "objective:one",
                "title": "Independent states",
                "description": "",
                "goal": "",
                "acceptance_criteria": "Tests pass",
                "verification_criteria": "",
                "priority": "medium",
                "lifecycle_state": "in_progress",
                "resource_version": 1,
                "revision": 1,
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

        let item = try XCTUnwrap(decoder().decode(CorptieTaskListEnvelope.self, from: data).tasks.first)
        XCTAssertEqual(item.lifecycleState, "in_progress")
        XCTAssertEqual(item.acceptanceAssessment?.status, "passed")
        XCTAssertEqual(item.completionSuggestion?.recommended, true)
    }

    func testMalformedAcceptanceAssessmentIsRejected() throws {
        let data = Data(
            """
            {
              "tasks": [{
                "id": "task:legacy",
                "objective_id": "objective:one",
                "title": "Legacy",
                "description": "",
                "goal": "",
                "acceptance_criteria": "",
                "verification_criteria": "",
                "priority": "medium",
                "lifecycle_state": "todo",
                "resource_version": 1,
                "revision": 1,
                "acceptanceAssessment": {},
                "created_at": "2026-08-18T00:00:00.000Z",
                "updated_at": "2026-08-18T00:00:00.000Z"
              }]
            }
            """.utf8
        )

        XCTAssertThrowsError(try decoder().decode(CorptieTaskListEnvelope.self, from: data))
    }

}
