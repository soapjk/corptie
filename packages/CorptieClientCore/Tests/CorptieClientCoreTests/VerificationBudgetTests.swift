import XCTest
@testable import CorptieClientCore

final class VerificationBudgetTests: XCTestCase {
    func testEntryOnlyBudgetAndUnknownReceiptDecodeWithoutStoredOutput() throws {
        let data = Data(#"{"instructionId":"instruction:1","limit":3,"used":1,"paused":true,"stopped":true,"running":false,"limitation":"entry only","runs":[{"execution_id":"run:1","status":"unknown"}]}"#.utf8)
        let budget = try JSONDecoder().decode(VerificationBudget.self, from: data)
        XCTAssertEqual(budget.id, "instruction:1")
        XCTAssertEqual(budget.used, 1)
        XCTAssertTrue(budget.paused)
        XCTAssertEqual(budget.runs.first?.status, "unknown")
        XCTAssertNil(budget.instruction)
    }
}
