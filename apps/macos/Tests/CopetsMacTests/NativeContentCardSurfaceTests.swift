import AppKit
import XCTest
import CorptieConversation
@testable import CorptieMac

@MainActor
final class NativeContentCardSurfaceTests: XCTestCase {
    func testTranslucentColorWithoutBlurOrSubviewGrowth() throws {
        let card = NativeContentCardSurface(frame: NSRect(x: 0, y: 0, width: 320, height: 80))
        let background = try XCTUnwrap(card.subviews.first)
        for _ in 0..<100 {
            card.configure(tint: .systemBlue)
            card.layoutSubtreeIfNeeded()
        }
        XCTAssertEqual(card.subviews.count, 1)
        XCTAssertTrue(card.subviews.first === background)
        XCTAssertFalse(background is NSVisualEffectView)
        XCTAssertEqual(card.layer?.shadowOpacity, 0)
    }

    func testReducedTransparencyAndIncreasedContrast() throws {
        let card = NativeContentCardSurface(frame: .zero)
        card.configure(tint: .systemBlue)
        card.refreshAppearance(reduceTransparency: true, increasedContrast: true)
        XCTAssertEqual(card.layer?.backgroundColor?.alpha, 1)
        XCTAssertEqual(card.layer?.borderWidth, 1)
        card.refreshAppearance(reduceTransparency: false, increasedContrast: false)
        XCTAssertLessThan(try XCTUnwrap(card.layer?.backgroundColor).alpha, 1)
        XCTAssertEqual(card.layer?.borderWidth, 0.5)
    }

    func testBackgroundAlphaTracksAppearanceWithoutDimmingContent() throws {
        let card = NativeContentCardSurface(frame: .zero)
        card.configure(tint: .systemBlue)
        for (appearance, expected) in [(NSAppearance.Name.aqua, 0.75), (.darkAqua, 0.80)] {
            card.appearance = try XCTUnwrap(NSAppearance(named: appearance))
            card.refreshAppearance(reduceTransparency: false, increasedContrast: false)
            XCTAssertEqual(try XCTUnwrap(card.layer?.backgroundColor).alpha, expected, accuracy: 0.001)
            XCTAssertEqual(card.alphaValue, 1)
        }
        card.configure(tint: .systemBlue, isMessage: false)
        card.refreshAppearance(reduceTransparency: false, increasedContrast: false)
        XCTAssertEqual(try XCTUnwrap(card.layer?.backgroundColor).alpha, 0.28, accuracy: 0.001)
    }
    func testSkinRoundTripRetainsClassicPaintAndViewGeometry() throws {
        let card = NativeContentCardSurface(frame: NSRect(x: 0, y: 0, width: 320, height: 80))
        card.appearance = try XCTUnwrap(NSAppearance(named: .aqua))
        card.configure(tint: .systemBlue)
        card.refreshAppearance(reduceTransparency: false, increasedContrast: false)
        let original = try XCTUnwrap(card.layer?.backgroundColor)
        let background = try XCTUnwrap(card.subviews.first)
        let frame = card.frame
        for _ in 0..<20 {
            card.updateSkin(.codexFlat, role: .assistant)
            XCTAssertEqual(card.layer?.backgroundColor?.alpha, 0)
            XCTAssertEqual(card.layer?.borderWidth, 0)
            card.updateSkin(.classic, role: .assistant)
            card.refreshAppearance(reduceTransparency: false, increasedContrast: false)
            XCTAssertEqual(card.layer?.backgroundColor, original)
        }
        XCTAssertEqual(card.frame, frame)
        XCTAssertEqual(card.subviews.count, 1)
        XCTAssertTrue(card.subviews.first === background)
        card.updateSkin(.codexFlat, role: .user)
        card.refreshAppearance(reduceTransparency: true, increasedContrast: true)
        XCTAssertGreaterThan(try XCTUnwrap(card.layer?.backgroundColor).alpha, 0)
        XCTAssertEqual(card.layer?.borderWidth, 1)
    }

}
