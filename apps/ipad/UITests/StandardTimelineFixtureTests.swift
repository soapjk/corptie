import XCTest

/// Actual touch against local product-card fixtures. No account or sends.
final class StandardTimelineFixtureTests: XCTestCase {
    @MainActor private func open() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CORPTIE_STANDARD_TIMELINE_FIXTURE"] = "1"
        app.launch()
        let open = app.buttons["standard-fixture-open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10)); open.tap()
        XCTAssertTrue(app.scrollViews["conversation-timeline"].waitForExistence(timeout: 10))
        return app
    }
    @MainActor private func assertDocked(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let tail = app.otherElements["conversation-latest-entry"].firstMatch
        let composer = app.otherElements["conversation-composer"].firstMatch
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            tail.exists && composer.exists && abs(composer.frame.minY - tail.frame.maxY - 8) < 3
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed, file: file, line: line)
        XCTAssertFalse(app.buttons["conversation-jump-to-latest"].exists, file: file, line: line)
    }
    @MainActor func testRealFingerHistoryFlickAndSingleJump() throws {
        let app = try open(); assertDocked(app)
        let timeline = app.scrollViews["conversation-timeline"]
        for _ in 0..<3 {
            timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
                .press(forDuration: 0.01, thenDragTo: timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)),
                    withVelocity: .fast, thenHoldForDuration: 0)
            let jump = app.buttons["conversation-jump-to-latest"]
            XCTAssertTrue(jump.waitForExistence(timeout: 3)); jump.tap(); assertDocked(app)
        }
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "standard-real-touch-latest"; image.lifetime = .keepAlways; add(image)
    }
    @MainActor func testActualMarkdownBackgroundGapsAfterRealDragging() throws {
        let app = try open(); let timeline = app.scrollViews["conversation-timeline"]
        var checked = 0
        for _ in 0..<8 {
            timeline.swipeDown(velocity: .slow)
            let cards = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-card-standard:"))
                .allElementsBoundByIndex.filter { $0.frame.intersects(timeline.frame) }.sorted { $0.frame.minY < $1.frame.minY }
            for (a, b) in zip(cards, cards.dropFirst()) {
                guard let first = Int(a.identifier.split(separator: ":").last!),
                      let second = Int(b.identifier.split(separator: ":").last!),
                      second == first + 1, first % 4 != 0, second % 4 != 0 else { continue }
                checked += 1
                XCTAssertEqual(b.frame.minY - a.frame.maxY, 12, accuracy: 2,
                    "Measure card backgrounds, not enclosing cell frames")
            }
        }
        XCTAssertGreaterThan(checked, 0, "Actual card measurement must not silently skip")
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "standard-real-touch-history"; image.lifetime = .keepAlways; add(image)
    }
    @MainActor func testKeyboardCyclesKeepActualLatestDocked() throws {
        let app = try open()
        let composer = app.otherElements["conversation-composer"].firstMatch
        let restingY = composer.frame.minY
        for _ in 0..<3 {
            let editor = app.textViews["conversation-composer-input"].firstMatch
            XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap()
            // The current device exposes its keyboard as inputView, not AXKeyboard.
            let raised = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                composer.frame.minY < restingY - 100
            }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [raised], timeout: 5), .completed)
            assertDocked(app)
            app.scrollViews["conversation-timeline"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                abs(composer.frame.minY - restingY) < 3
            }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed); assertDocked(app)
        }
    }
    @MainActor func testManualReturnToBottomThenKeyboardKeepsLatestDocked() throws {
        let app = try open()
        let timeline = app.scrollViews["conversation-timeline"]
        assertDocked(app)
        timeline.swipeDown(velocity: .slow)
        timeline.swipeUp(velocity: .fast)
        timeline.swipeUp(velocity: .fast)
        assertDocked(app)
        let composer = app.otherElements["conversation-composer"].firstMatch
        let restingY = composer.frame.minY
        app.textViews["conversation-composer-input"].firstMatch.tap()
        let raised = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.frame.minY < restingY - 100
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [raised], timeout: 5), .completed)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "manual-bottom-keyboard"; screenshot.lifetime = .keepAlways; add(screenshot)
        assertDocked(app)
    }
    @MainActor func testHistoryBookmarkSurvivesReopeningFixture() throws {
        let app = try open(); let timeline = app.scrollViews["conversation-timeline"]
        timeline.swipeDown(); timeline.swipeDown()
        let rows = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "conversation-entry-message:standard:"))
        let anchor = try XCTUnwrap(rows.allElementsBoundByIndex.first {
            $0.frame.minY > timeline.frame.minY + 110 && $0.frame.minY < timeline.frame.maxY - 200
        })
        let id = anchor.identifier, y = anchor.frame.minY
        app.buttons["conversation-back"].tap(); app.buttons["standard-fixture-open"].tap()
        let restored = app.otherElements[id].firstMatch
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            restored.exists && abs(restored.frame.minY - y) < 8
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 8), .completed)
        XCTAssertTrue(app.buttons["conversation-jump-to-latest"].exists)
    }
    @MainActor func testNewReplyFollowsOnlyWhenReadingLatest() throws {
        let app = try open(); assertDocked(app)
        app.buttons["standard-fixture-append"].tap(); assertDocked(app)
        app.scrollViews["conversation-timeline"].swipeDown()
        XCTAssertTrue(app.buttons["conversation-jump-to-latest"].waitForExistence(timeout: 3))
        app.buttons["standard-fixture-append"].tap()
        XCTAssertTrue(app.buttons["conversation-jump-to-latest"].exists)
        app.buttons["conversation-jump-to-latest"].tap(); assertDocked(app)
    }
    @MainActor func testStreamingReplyAndLocalImageProcessCards() throws {
        let app = try open()
        app.buttons["standard-fixture-stream"].tap()
        Thread.sleep(forTimeInterval: 2)
        assertDocked(app)
        app.buttons["standard-fixture-rich"].tap()
        // Attachment bytes are supplied locally; the real thumbnail and process
        // presentation are still exercised, without network or execution.
        assertDocked(app)
        app.scrollViews["conversation-timeline"].swipeDown(velocity: .slow)
        XCTAssertTrue(app.buttons["conversation-jump-to-latest"].waitForExistence(timeout: 3))
        app.buttons["conversation-jump-to-latest"].tap(); assertDocked(app)
    }
    @MainActor func testScrollPerformanceOfComplexLocalCards() throws {
        let app = try open(); let timeline = app.scrollViews["conversation-timeline"]
        let options = XCTMeasureOptions(); options.iterationCount = 3
        measure(metrics: [XCTClockMetric(), XCTOSSignpostMetric.scrollDecelerationMetric], options: options) {
            timeline.swipeDown(velocity: .fast); timeline.swipeUp(velocity: .fast)
        }
    }
}
