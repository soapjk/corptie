import XCTest

final class ConversationNavigationTests: XCTestCase {
    @MainActor
    func testJumpWorksAfterFastHistoryFlickWithoutKeyboard() throws {
        let app = XCUIApplication()
        app.launch()
        let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "outline-session-")).firstMatch
        guard session.waitForExistence(timeout: 20) else {
            throw XCTSkip("Requires a paired iPhone with scrollable history")
        }
        session.tap()
        let timeline = app.scrollViews["conversation-timeline"].firstMatch
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        let start = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        let end = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
        let jump = app.buttons["conversation-jump-to-latest"]
        XCTAssertTrue(jump.exists, "The button must not wait for an idle-only presentation rule")
        jump.tap()
        assertLatestDocked(app.otherElements["conversation-latest-entry"].firstMatch,
            timeline: timeline, composer: app.otherElements["conversation-composer"].firstMatch)
        XCTAssertFalse(jump.exists)
        // XCTest may wait for quiescence between commands; a second-finger
        // tap DURING an active drag still requires explicit manual acceptance.
    }
    @MainActor
    func testHistoryReadingPositionSurvivesLeavingConversation() throws {
        let app = XCUIApplication()
        app.launch()
        let session = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "outline-session-")
        ).firstMatch
        guard session.waitForExistence(timeout: 20) else {
            throw XCTSkip("Requires a paired iPhone with scrollable conversation history")
        }
        session.tap()
        let back = app.buttons["conversation-back"]
        guard back.waitForExistence(timeout: 3) else { throw XCTSkip("Requires compact layout") }
        let timeline = app.scrollViews["conversation-timeline"].firstMatch
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        timeline.swipeDown()
        timeline.swipeDown()
        XCTAssertTrue(app.buttons["conversation-jump-to-latest"].waitForExistence(timeout: 5))
        let rows = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "conversation-entry-"))
        let anchor = try XCTUnwrap(rows.allElementsBoundByIndex.first {
            $0.frame.intersects(timeline.frame) && $0.frame.minY >= timeline.frame.minY
        }, "Requires a visible historical row")
        let identity = anchor.identifier
        let relativeY = anchor.frame.minY - timeline.frame.minY
        back.tap()
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        session.tap()
        let restored = app.otherElements[identity].firstMatch
        let matched = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            restored.exists && abs(restored.frame.minY - timeline.frame.minY - relativeY) < 8
        }, object: restored)
        XCTAssertEqual(XCTWaiter.wait(for: [matched], timeout: 10), .completed)
        XCTAssertTrue(app.buttons["conversation-jump-to-latest"].exists)
    }

    @MainActor
    func testHistoryDragShowsJumpAndConfirmedJumpHidesIt() throws {
        let app = XCUIApplication()
        app.launch()
        let session = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "outline-session-")
        ).firstMatch
        guard session.waitForExistence(timeout: 20) else {
            throw XCTSkip("Requires a paired device and a conversation with scrollable history")
        }
        session.tap()
        let timeline = app.scrollViews["conversation-timeline"].firstMatch
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        let jump = app.buttons["conversation-jump-to-latest"]
        if jump.exists { jump.tap() }
        for _ in 0..<3 {
            timeline.swipeDown()
            XCTAssertTrue(jump.waitForExistence(timeout: 5), "History reading must show the jump control after deceleration")
            jump.tap()
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: jump)
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
            assertLatestDocked(app.otherElements["conversation-latest-entry"].firstMatch,
                timeline: timeline, composer: app.otherElements["conversation-composer"].firstMatch)
        }
    }

    @MainActor
    func testLatestCardsRemainVisibleAndDockedAcrossKeyboardCycles() throws {
        let app = XCUIApplication()
        app.launch()
        let session = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "outline-session-")
        ).firstMatch
        guard session.waitForExistence(timeout: 20) else {
            throw XCTSkip("A paired test device with message history is required")
        }
        session.tap()
        guard app.buttons["conversation-back"].waitForExistence(timeout: 3) else {
            throw XCTSkip("This regression exercises the compact iPhone conversation")
        }
        let timeline = app.scrollViews["conversation-timeline"].firstMatch
        let composer = app.otherElements["conversation-composer"].firstMatch
        let latest = app.otherElements["conversation-latest-entry"].firstMatch
        let input = app.descendants(matching: .any)["conversation-composer-input"].firstMatch
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        XCTAssertTrue(latest.waitForExistence(timeout: 10), "Require a real message row, not a tail sentinel")
        for _ in 0..<10 {
            let jump = app.buttons["conversation-jump-to-latest"]
            if jump.exists { jump.tap() }
            input.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            assertLatestDocked(latest, timeline: timeline, composer: composer)
            timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.05)).tap()
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
                object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
            assertLatestDocked(latest, timeline: timeline, composer: composer)
            XCTAssertFalse(app.buttons["conversation-jump-to-latest"].exists,
                "Keyboard-only layout changes must not show a history jump control")
        }
    }

    @MainActor
    private func assertLatestDocked(_ latest: XCUIElement, timeline: XCUIElement, composer: XCUIElement,
                                    file: StaticString = #filePath, line: UInt = #line) {
        let docked = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            latest.exists && composer.exists && latest.frame.intersects(timeline.frame)
                && abs(latest.frame.maxY - composer.frame.minY) <= 60
        }, object: latest)
        XCTAssertEqual(XCTWaiter.wait(for: [docked], timeout: 5), .completed,
            "Real cards must remain visible; latest must be above composer, not mid-screen", file: file, line: line)
    }

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
