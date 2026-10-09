import AppKit
import QuartzCore
import Metal
import XCTest
import CorptieClientCore
@testable import CorptieMac

@MainActor
final class NativeMessageStatusGlowTests: XCTestCase {
    private func status(_ value: String) throws -> UserMessageStatusPresentation {
        try XCTUnwrap(UserMessageStatusPresentation(authoritativeStatus: value, legacyStatus: nil))
    }

    func testAnimationLifecycleAndStableGeometry() throws {
        _ = NSApplication.shared
        let glow = NativeMessageStatusGlow(frame: NSRect(x: 0, y: 0, width: 120, height: 44))
        glow.layoutSubtreeIfNeeded()
        let count = glow.pathUpdateCount
        for _ in 0..<1000 { glow.configure(try status("processing")) }
        XCTAssertEqual(glow.pathUpdateCount, count)
        glow.updateAnimation(isVisible: true, reduceMotion: false, appActive: true)
        let animation = try XCTUnwrap(glow.layer?.animation(forKey: NativeMessageStatusGlow.pulseKey) as? CABasicAnimation)
        XCTAssertEqual(animation.keyPath, "shadowOpacity")
        XCTAssertEqual(glow.layer?.animationKeys(), [NativeMessageStatusGlow.pulseKey])
        for conditions in [(false, false, true), (true, true, true), (true, false, false)] {
            glow.updateAnimation(isVisible: conditions.0, reduceMotion: conditions.1, appActive: conditions.2)
            XCTAssertNil(glow.layer?.animation(forKey: NativeMessageStatusGlow.pulseKey))
        }
        glow.configure(try status("queued"))
        glow.updateAnimation(isVisible: true, reduceMotion: false, appActive: true)
        XCTAssertNil(glow.layer?.animationKeys())
        XCTAssertGreaterThan(glow.layer?.shadowOpacity ?? 0, 0)
        glow.configure(try status("cancelled"))
        XCTAssertEqual(glow.layer?.shadowOpacity, 0)
        XCTAssertNil(glow.hitTest(.zero))
    }

    func testRoundedShadowRendersOutsideDecorationBounds() throws {
        _ = NSApplication.shared
        let glow = NativeMessageStatusGlow(frame: NSRect(x: 20, y: 20, width: 120, height: 44))
        glow.configure(try status("failed"))
        glow.layoutSubtreeIfNeeded()
        let layer = try XCTUnwrap(glow.layer)
        XCTAssertFalse(layer.masksToBounds)
        XCTAssertEqual(layer.shadowPath?.boundingBox, glow.bounds)
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("Metal unavailable") }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm,
            width: 160, height: 84, mipmapped: false)
        descriptor.storageMode = .shared
        descriptor.usage = [.renderTarget, .shaderRead]
        let texture = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
        let root = CALayer()
        root.frame = NSRect(x: 0, y: 0, width: 160, height: 84)
        root.addSublayer(layer)
        layer.frame = glow.frame
        let control = CALayer()
        control.frame = NSRect(x: 150, y: 74, width: 10, height: 10)
        control.backgroundColor = NSColor.white.cgColor
        root.addSublayer(control)
        CATransaction.flush()
        // Use the actual Core Animation compositor; CALayer.render(in:) does
        // not reproduce this native shadow in an AppKit bitmap context.
        let queue = try XCTUnwrap(device.makeCommandQueue())
        let renderer = CARenderer(mtlTexture: texture, options: [kCARendererMetalCommandQueue: queue])
        renderer.layer = root
        renderer.bounds = root.bounds
        renderer.beginFrame(atTime: CACurrentMediaTime(), timeStamp: nil)
        renderer.addUpdate(root.bounds)
        renderer.render()
        renderer.endFrame()
        let fence = try XCTUnwrap(queue.makeCommandBuffer())
        fence.commit()
        fence.waitUntilCompleted()
        var pixels = [UInt8](repeating: 0, count: 160 * 84 * 4)
        pixels.withUnsafeMutableBytes {
            texture.getBytes($0.baseAddress!, bytesPerRow: 160 * 4,
                from: MTLRegionMake2D(0, 0, 160, 84), mipmapLevel: 0)
        }
        func alpha(_ x: Int, _ y: Int) -> UInt8 { pixels[(y * 160 + x) * 4 + 3] }
        guard alpha(155, 79) > 0 || alpha(155, 4) > 0 else {
            throw XCTSkip("Core Animation Metal renderer produced no control pixels in this environment; visual acceptance remains unverified")
        }
        XCTAssertGreaterThan(alpha(80, 18), 2,
                             "The halo must paint beyond the card, not stop at its rectangular bounds")
        XCTAssertLessThan(alpha(18, 18), alpha(80, 18))
    }

    func testRowOverflowDoesNotDisableViewportClipping() {
        _ = NSApplication.shared
        let clip = NSClipView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        clip.clipsToBounds = true
        let row = NSTableRowView(frame: clip.bounds)
        row.clipsToBounds = true
        clip.documentView = row
        let cell = NSTableCellView(frame: row.bounds)
        row.addSubview(cell)
        let glow = NativeMessageStatusGlow(frame: cell.bounds)
        cell.addSubview(glow)
        XCTAssertFalse(row.clipsToBounds)
        XCTAssertTrue(clip.clipsToBounds)
    }

    func testProductionSharedCellOwnsGlowOutsideHostingTreeAndClearsOnReuse() throws {
        _ = NSApplication.shared
        let message = AppKitChatTimelineRow(id: "glow-user", contentRevision: 1,
            nativeText: "Hello", copyText: "Hello", nativeStyle: .user,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false, messageStatus: try status("processing"))
        let measured = NativeTimelineLayoutCache.shared.layout(for: message, columnWidth: 400)
        let cell = AppKitSharedMessageTextCell(identifier: .init("glow-shared"))
        cell.frame = NSRect(x: 0, y: 0, width: 400, height: measured.rowHeight)
        cell.setContent(message, availableWidth: 400, onToggleExpansion: { _ in })
        cell.layoutSubtreeIfNeeded()
        let glow = try XCTUnwrap(cell.subviews.compactMap { $0 as? NativeMessageStatusGlow }.first)
        XCTAssertEqual(cell.subviews.count, 2, "The glow must be a sibling, not inside the hosting clip")
        XCTAssertEqual(glow.frame.width, measured.cardWidth)
        XCTAssertEqual(glow.frame.height, measured.rowHeight - 2)
        XCTAssertEqual(glow.frame.maxX, 398)
        let plain = AppKitChatTimelineRow(id: "glow-user", contentRevision: 2,
            nativeText: "Hello", copyText: "Hello", nativeStyle: .user,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(for: plain, columnWidth: 400).rowHeight,
                       measured.rowHeight)
        cell.setContent(plain, availableWidth: 400, onToggleExpansion: { _ in })
        XCTAssertNil(glow.superview)
        XCTAssertEqual(cell.subviews.count, 1)
    }
}
