import XCTest

final class ConversationNavigationTests: XCTestCase {
    @MainActor
    func testPairedDeviceOpensTaskConversation() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["navigation-settings"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["workspace-settings"].exists)
        XCTAssertFalse(app.navigationBars["工作台"].exists)

        let usesRail = app.otherElements["navigation-rail"].exists
        for index in 0..<4 {
            XCTAssertTrue(app.buttons["tab-\(index)"].exists)
        }
        if usesRail {
            XCTAssertFalse(app.buttons["navigation-rail-toggle"].exists)
            let resizer = app.otherElements["navigation-rail-resizer"]
            XCTAssertTrue(resizer.waitForExistence(timeout: 5) && resizer.isHittable)
            let wasExpanded = (resizer.value as? String) == "已展开"
            let start = resizer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(
                forDuration: 0.1,
                thenDragTo: start.withOffset(CGVector(dx: wasExpanded ? -80 : 80, dy: 0))
            )
            XCTAssertEqual(
                app.otherElements["navigation-rail-resizer"].value as? String,
                wasExpanded ? "已折叠" : "已展开"
            )
            XCTAssertTrue(app.buttons["navigation-settings"].exists)
            let restoredResizer = app.otherElements["navigation-rail-resizer"]
            let restoredStart = restoredResizer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            restoredStart.press(
                forDuration: 0.1,
                thenDragTo: restoredStart.withOffset(CGVector(dx: wasExpanded ? 80 : -80, dy: 0))
            )
        }

        app.buttons["navigation-settings"].tap()
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["tab-0"].waitForExistence(timeout: 5))

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
        if usesRail {
            XCTAssertTrue(app.otherElements["navigation-rail"].exists,
                          "The iPad navigation rail must remain visible with the keyboard open")
        } else {
            XCTAssertFalse(app.buttons["navigation-settings"].exists,
                           "Compact bottom navigation must hide with the keyboard")
        }
        XCTAssertTrue(input.isHittable, "Composer must remain visible above the keyboard")
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertFalse(app.buttons["刷新消息"].exists)
        XCTAssertFalse(app.buttons["最新消息"].exists)
        XCTAssertFalse(app.buttons["加载更早消息"].exists)
        XCTAssertFalse(app.buttons["workspace-toggle-sidebar"].exists)
        for systemSidebarLabel in ["显示边栏", "隐藏边栏", "Show Sidebar", "Hide Sidebar", "Toggle Sidebar"] {
            XCTAssertFalse(app.buttons[systemSidebarLabel].exists,
                           "NavigationSplitView must not inject its system sidebar toggle")
        }
        // The stop control is intentionally conditional: it only exists while the
        // displayed session is actively running and can be interrupted.
        // The removed toolbar must not be required to dismiss the keyboard.
        app.scrollViews["conversation-timeline"].firstMatch
            .coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.05)).tap()
        let dismissed = NSPredicate(format: "exists == false")
        expectation(for: dismissed, evaluatedWith: app.keyboards.firstMatch)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(input.isHittable)
    }
}
