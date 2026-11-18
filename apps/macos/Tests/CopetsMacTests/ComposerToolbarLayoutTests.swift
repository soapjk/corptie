import AppKit
import SwiftUI
import XCTest
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ComposerToolbarLayoutTests: XCTestCase {
    private func resources() throws -> Bundle {
        try XCTUnwrap(Bundle(url: Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
            .appendingPathComponent("CorptieMac_CorptieMac.bundle")))
    }

    func testNativeMenuImagesHaveSmallPointAndRasterRepresentationsWithoutMutatingSources() throws {
        let bundle = try resources()
        for provider in ["codex", "claude-sdk", "openclacky"] {
            let source = try XCTUnwrap(ProviderBrandIcon.image(for: provider, providers: [], resourceBundle: bundle))
            let originalSize = source.size
            let icon = try XCTUnwrap(ProviderBrandIcon.menuImage(for: provider, providers: [], resourceBundle: bundle))
            XCTAssertEqual(icon.size, NSSize(width: 14, height: 14))
            let bitmaps = icon.representations.compactMap { $0 as? NSBitmapImageRep }
            XCTAssertEqual(bitmaps.map(\.pixelsWide), [14, 28])
            XCTAssertTrue(bitmaps.allSatisfy { $0.size == NSSize(width: 14, height: 14) && $0.pixelsHigh == $0.pixelsWide })
            XCTAssertEqual(source.size, originalSize)
            XCTAssertFalse(icon === source)
        }
    }

    func testBorderlessNativeMenuDoesNotRecoverOriginalLargeImageSize() async throws {
        _ = NSApplication.shared
        let icon = try XCTUnwrap(ProviderBrandIcon.menuImage(for: "codex", providers: [], resourceBundle: resources()))
        // Exercise the exact Menu bridge and fixedSize combination of the new
        // page; a SwiftUI-only ImageRenderer would miss this regression.
        let host = NSHostingView(rootView: HStack(spacing: 8) {
            ComposerPermissionMenu(selection: .init(sandbox: "danger-full-access", approval: "never"), disabled: false) { _ in }
            Menu {
                Button("Model") {}
            } label: {
                HStack(spacing: 4) {
                    Image(nsImage: icon).resizable().scaledToFit().frame(width: 14, height: 14)
                    Text("gpt-6-astra").lineLimit(1)
                }
            }.menuStyle(.borderlessButton).fixedSize()
        })
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 40),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        window.orderFront(nil)
        try await Task.sleep(for: .milliseconds(60))
        host.layoutSubtreeIfNeeded()
        let controls = buttons(in: host)
        XCTAssertEqual(controls.count, 2)
        let permission = try XCTUnwrap(controls.first)
        let menu = try XCTUnwrap(controls.last)
        // AppKit controls include hit-area insets outside the alignment rect
        // that SwiftUI uses for spacing. Compare visible layout, not hit bounds.
        let permissionFrame = permission.convert(permission.alignmentRect(forFrame: permission.bounds), to: host)
        let menuFrame = menu.convert(menu.alignmentRect(forFrame: menu.bounds), to: host)
        XCTAssertEqual(menuFrame.minX - permissionFrame.maxX, 8, accuracy: 1)
        XCTAssertLessThanOrEqual(menu.fittingSize.height, 32)
        XCTAssertLessThanOrEqual(host.fittingSize.height, 32)
        if let bridged = menu.image { XCTAssertLessThanOrEqual(bridged.size.height, 14) }
        print("[composer-menu-evidence] native button \(type(of: menu)), height=\(menu.fittingSize.height)pt, source=\(icon.size), permission gap=\(menuFrame.minX - permissionFrame.maxX)pt")
    }

    func testInlineUsageAndStatusKeepOneToolbarRowForDataMissingAndFailure() throws {
        let data = try JSONDecoder().decode(SessionUsageResponse.self, from: Data(
            #"{"account":{"available":true,"provider":"fixture","rateLimits":{"primary":{"usedPercent":25}}},"context":{"usedTokens":80,"contextWindow":100}}"#.utf8))
        for width in [240.0, 420.0, 700.0] {
            for state in [UsageLoadState.ready, .loading, .failed] {
                for snapshot in [data, nil] as [SessionUsageResponse?] {
                    let usage = ChatUsageBar(sessionID: "fixture", usage: snapshot, loadState: state, inline: true)
                    // "No data" hides the element entirely; loading / failure /
                    // unsupported keep their caption but still fit one row.
                    let showsNoData = snapshot == nil && state == .ready
                    if showsNoData {
                        XCTAssertNil(ImageRenderer(content: usage.frame(width: width)).nsImage,
                            "No-data usage must not render a placeholder element")
                    } else if let image = ImageRenderer(content: usage.frame(width: width)).nsImage {
                        XCTAssertLessThanOrEqual(image.size.height, 32, "Usage must fit the existing toolbar interaction height")
                    }
                    let status = ConversationComposerStatusRow(isReady: true, readinessTitle: "", readinessMessage: "",
                        readinessCode: nil, executionState: nil, activity: nil) { usage }.frame(width: width)
                    let statusImage = try XCTUnwrap(ImageRenderer(content: status).nsImage)
                    XCTAssertLessThanOrEqual(statusImage.size.height, 32)
                }
            }
        }
    }

    func testCompactUsageAndStatusKeepOneToolbarRow() throws {
        let data = try JSONDecoder().decode(SessionUsageResponse.self, from: Data(
            #"{"account":{"available":true,"provider":"fixture","rateLimits":{"primary":{"usedPercent":25}}},"context":{"usedTokens":80,"contextWindow":100}}"#.utf8))
        for width in [240.0, 340.0, 420.0] {
            let usage = ChatUsageBar(sessionID: "fixture", usage: data, loadState: .ready,
                inline: true, compact: true)
            let usageImage = try XCTUnwrap(ImageRenderer(content: usage.frame(width: width)).nsImage)
            XCTAssertLessThanOrEqual(usageImage.size.height, 32,
                "Compact usage must stay on one 32pt toolbar row at \(width)pt")

            let status = ConversationComposerStatusRow(isReady: true, readinessTitle: "", readinessMessage: "",
                readinessCode: nil, executionState: .complete, activity: nil, compact: true) { usage }
            let statusImage = try XCTUnwrap(ImageRenderer(content: status.frame(width: width)).nsImage)
            XCTAssertLessThanOrEqual(statusImage.size.height, 32,
                "Compact status must stay on one 32pt toolbar row at \(width)pt")
        }
    }

    func testToolbarDensityHysteresisBand() {
        // Collapse only below 520, restore only above 600; the 80pt gap keeps
        // a live resize from flapping the composer between two densities.
        XCTAssertLessThan(ComposerToolbarDensity.collapseBelow, ComposerToolbarDensity.restoreAbove)
        XCTAssertEqual(ComposerToolbarDensity.restoreAbove - ComposerToolbarDensity.collapseBelow, 80)
    }

    private func buttons(in view: NSView) -> [NSButton] {
        if let button = view as? NSButton { return [button] }
        return view.subviews.flatMap { self.buttons(in: $0) }
    }
}
