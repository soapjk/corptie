import XCTest

final class ConversationNavigationTests: XCTestCase {
    @MainActor
    func testCompactWorkbenchReusesConversationAndDetailPages() throws {
        let app = XCUIApplication()
        app.launch()

        let session = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "outline-session-")
        ).firstMatch
        guard session.waitForExistence(timeout: 20) else {
            throw XCTSkip("No independent session is available on this paired device")
        }
        session.tap()
        let back = app.buttons["conversation-back"]
        guard back.waitForExistence(timeout: 3) else {
            throw XCTSkip("This window is using the wide three-column workbench")
        }

        XCTAssertTrue(app.scrollViews["conversation-timeline"].waitForExistence(timeout: 10))
        let openDetail = app.buttons["conversation-open-detail"]
        XCTAssertTrue(openDetail.isHittable)
        openDetail.tap()
        let inspector = app.descendants(matching: .any)["conversation-detail-inspector"].firstMatch
        XCTAssertTrue(inspector.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "conversation-detail-back").count, 1)
        XCTAssertFalse(app.navigationBars.firstMatch.exists,
                       "Compact Detail must not show a second system back button")
        let detailSwipeStart = inspector.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.5))
        detailSwipeStart.press(forDuration: 0.05,
            thenDragTo: detailSwipeStart.withOffset(CGVector(dx: 120, dy: 0)))
        XCTAssertTrue(openDetail.waitForExistence(timeout: 5))

        back.tap()
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        session.tap()
        XCTAssertTrue(openDetail.waitForExistence(timeout: 5),
                      "Opening the same Task again must return to its conversation")

        let timeline = app.scrollViews["conversation-timeline"].firstMatch
        let message = app.otherElements["conversation-message"].firstMatch
        if message.exists {
            XCTAssertGreaterThanOrEqual(message.frame.minX, timeline.frame.minX - 1)
            XCTAssertLessThanOrEqual(message.frame.maxX, timeline.frame.maxX + 1)
        }
        // Start away from screen edges to exercise the page-owned pan.
        let start = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5))
        let end = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertTrue(app.buttons["conversation-detail-back"].waitForExistence(timeout: 5))
        app.buttons["conversation-detail-back"].tap()
        let backSwipeStart = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
        backSwipeStart.press(forDuration: 0.05,
            thenDragTo: backSwipeStart.withOffset(CGVector(dx: 120, dy: 0)))
        XCTAssertTrue(session.waitForExistence(timeout: 5))
    }

    @MainActor
    func testWideWorkbenchKeepsDetailBesideConversation() throws {
        let app = XCUIApplication()
        app.launch()
        guard app.otherElements["navigation-rail"].waitForExistence(timeout: 20) else {
            throw XCTSkip("The wide navigation rail is only available on iPad")
        }
        if app.descendants(matching: .any)["compact-workspace"].firstMatch.exists {
            throw XCTSkip("This iPad window is using the compact page layout")
        }

        let session = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "outline-session-")
        ).firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 20))
        session.tap()

        let timeline = app.scrollViews["conversation-timeline"].firstMatch
        let inspector = app.descendants(matching: .any)["conversation-detail-inspector"].firstMatch
        XCTAssertTrue(timeline.waitForExistence(timeout: 20))
        XCTAssertTrue(inspector.waitForExistence(timeout: 20))
        XCTAssertLessThan(session.frame.maxX, timeline.frame.minX)
        XCTAssertLessThan(timeline.frame.maxX, inspector.frame.minX)
    }

    @MainActor
    func testExpandedNavigationRowsRemainBounded() throws {
        let app = XCUIApplication()
        app.launch()
        let resizer = app.otherElements["navigation-rail-resizer"]
        guard resizer.waitForExistence(timeout: 20) else {
            throw XCTSkip("The expandable navigation rail is only available on iPad")
        }
        let wasExpanded = (resizer.value as? String) == "已展开"
        if !wasExpanded {
            let start = resizer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 80, dy: 0)))
        }
        XCTAssertEqual(resizer.value as? String, "已展开")
        let rail = app.otherElements["navigation-rail"]
        for index in 0..<4 {
            let row = app.buttons["tab-\(index)"]
            XCTAssertTrue(row.isHittable)
            XCTAssertEqual(row.frame.height, 44, accuracy: 1)
            XCTAssertLessThanOrEqual(row.frame.width, 200)
            XCTAssertGreaterThanOrEqual(row.frame.minX, rail.frame.minX)
            XCTAssertLessThanOrEqual(row.frame.maxX, rail.frame.maxX)
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.lifetime = .keepAlways
        add(screenshot)
        if !wasExpanded {
            let start = resizer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: -80, dy: 0)))
        }
    }

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
        let message = app.otherElements["conversation-message"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 20),
                      "Tapping an active Task must load its messages.\n\(app.debugDescription)")
        message.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["复制消息"].waitForExistence(timeout: 3))
        let selectText = app.buttons["选择文本"]
        XCTAssertTrue(selectText.exists)
        selectText.tap()
        let input = app.descendants(matching: .any)["conversation-composer-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertTrue(input.isHittable)
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        if usesRail {
            XCTAssertTrue(app.otherElements["navigation-rail"].exists,
                          "The iPad navigation rail must remain visible with the keyboard open")
            XCTAssertTrue(app.buttons["conversation-composer-send"].exists)
        } else {
            XCTAssertFalse(app.buttons["navigation-settings"].exists,
                           "Compact bottom navigation must hide with the keyboard")
            XCTAssertFalse(app.buttons["conversation-composer-send"].exists,
                           "iPhone sends from the keyboard instead of a duplicate composer button")
            XCTAssertGreaterThanOrEqual(input.frame.height, 36)
            let model = app.buttons["conversation-composer-model"]
            if model.exists {
                XCTAssertLessThanOrEqual(model.frame.maxY, input.frame.minY,
                                         "The iPhone model menu belongs in the status row above the editor")
            }
            let stop = app.buttons["conversation-stop"]
            if stop.exists {
                XCTAssertGreaterThanOrEqual(stop.frame.minX, input.frame.maxX,
                                            "The iPhone stop button belongs in the former send slot")
                XCTAssertLessThanOrEqual(stop.frame.maxY, input.frame.maxY,
                                         "The iPhone stop button must stay inside the editor row")
            }
        }
        XCTAssertTrue(input.isHittable, "Composer must remain visible above the keyboard")
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertFalse(app.buttons["刷新消息"].exists)
        XCTAssertFalse(app.buttons["workspace-refresh"].exists)
        XCTAssertFalse(app.buttons["workspace-load-more"].exists)
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
