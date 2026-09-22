import XCTest

final class ConversationNavigationTests: XCTestCase {
    @MainActor
    func testPairedDeviceOpensTaskConversation() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["workspace-settings"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.navigationBars["工作台"].exists)
        let row = app.staticTexts["iOSiPadOS开发"].firstMatch
        for _ in 0..<20 {
            if row.exists && row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.exists && row.isHittable, "Target Task must be visible")
        row.tap()
        XCTAssertTrue(app.otherElements["conversation-message"].firstMatch.waitForExistence(timeout: 20),
                      "Tapping an active Task must load its messages.\n\(app.debugDescription)")
        let input = app.descendants(matching: .any)["conversation-composer-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertTrue(input.isHittable)
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(input.isHittable, "Composer must remain visible above the keyboard")
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertFalse(app.buttons["刷新消息"].exists)
        XCTAssertFalse(app.buttons["最新消息"].exists)
        XCTAssertTrue(app.buttons["conversation-stop"].exists)
        XCTAssertTrue(app.buttons["workspace-toggle-sidebar"].exists)
        // The removed toolbar must not be required to dismiss the keyboard.
        app.scrollViews["conversation-timeline"].firstMatch
            .coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.05)).tap()
        let dismissed = NSPredicate(format: "exists == false")
        expectation(for: dismissed, evaluatedWith: app.keyboards.firstMatch)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(input.isHittable)
    }
}
