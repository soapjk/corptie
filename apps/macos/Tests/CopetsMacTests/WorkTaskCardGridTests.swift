import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class WorkTaskCardGridTests: XCTestCase {
    func testWidthIsBoundedAndIndependentOfTaskTextOrSelection() {
        for count in [0, 1, 2, 3, 1000] {
            for available in [CGFloat(140), 240, 420, 640, 1000] {
                let width = WorkTaskGridMetrics.contentWidth(itemCount: count, availableWidth: available)
                XCTAssertGreaterThan(width, 0)
                XCTAssertLessThanOrEqual(width + WorkTaskGridMetrics.groupHorizontalPadding, available)
                XCTAssertLessThanOrEqual(width, WorkTaskGridMetrics.maximumContentWidth)
            }
        }
        XCTAssertEqual(WorkTaskGridMetrics.contentWidth(itemCount: 1, availableWidth: 1000), 264)
        XCTAssertEqual(WorkTaskGridMetrics.contentWidth(itemCount: 2, availableWidth: 1000), 536)
        XCTAssertEqual(WorkTaskGridMetrics.contentWidth(itemCount: 3, availableWidth: 1000), 768)
        XCTAssertEqual(WorkTaskGridMetrics.contentWidth(itemCount: 1000, availableWidth: 1000), 768)
        XCTAssertTrue(WorkTaskGridMetrics.contentWidth(itemCount: 3, availableWidth: .infinity).isFinite)
    }

    func testNativeGridWrapsInSourceOrderWithoutOverlappingOrClippingLongTitles() throws {
        _ = NSApplication.shared
        for available in [CGFloat(240), 420, 640, 1000] {
            let grid = WorkTaskCardGrid(itemCount: 6, availableWidth: available) {
                ForEach(0..<6, id: \.self) { id in
                    Self.card(id).background(GridCellProbe(id: id))
                }
            }
            let host = NSHostingView(rootView: grid.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading))
            let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: available, height: 2000),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            defer { window.contentView = nil; window.close() }
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            host.layoutSubtreeIfNeeded()
            let probes = Self.probes(in: host)
            XCTAssertEqual(probes.count, 6)
            let frames = try (0..<6).map { id -> CGRect in
                let view = try XCTUnwrap(probes[id])
                return view.convert(view.bounds, to: host)
            }
            for frame in frames {
                XCTAssertGreaterThan(frame.height, 30)
                XCTAssertGreaterThanOrEqual(frame.minX, -0.5)
                XCTAssertLessThanOrEqual(frame.maxX, available + 0.5)
            }
            for i in frames.indices {
                for j in frames.indices where i < j {
                    XCTAssertFalse(frames[i].insetBy(dx: 0.5, dy: 0.5).intersects(frames[j].insetBy(dx: 0.5, dy: 0.5)))
                }
            }
            if available < 400 {
                XCTAssertEqual(frames[0].minX, frames[1].minX, accuracy: 0.5)
                XCTAssertGreaterThan(frames[1].minY, frames[0].minY)
            } else {
                XCTAssertEqual(frames[0].minY, frames[1].minY, accuracy: 0.5)
                XCTAssertGreaterThan(frames[1].minX, frames[0].minX)
                let firstInNextRow = available < 600 ? 2 : 3
                XCTAssertGreaterThan(frames[firstInNextRow].minY, frames[0].minY)
            }
        }
    }

    func testRepeatedGridLayoutFitsExistingStackBudget() {
        _ = NSApplication.shared
        let grid = NSHostingView(rootView: WorkTaskCardGrid(itemCount: 60, availableWidth: 640) {
            ForEach(0..<60, id: \.self) { Self.card($0) }
        })
        let stack = NSHostingView(rootView: VStack(alignment: .leading, spacing: 8) {
            ForEach(0..<60, id: \.self) { id in ContentSizedTaskCardLayout { Self.card(id) } }
        })
        func measurement<V: View>(_ host: NSHostingView<V>, iteration: Int) -> Double {
            let start = ProcessInfo.processInfo.systemUptime
            host.frame = CGRect(x: 0, y: 0, width: 600 + iteration % 2, height: 10000)
            host.layoutSubtreeIfNeeded()
            return (ProcessInfo.processInfo.systemUptime - start) * 1000
        }
        // Interleave and alternate order so system load/thermal drift cannot
        // unfairly favour the first implementation. Keep the original budget.
        var original: [Double] = [], updated: [Double] = []
        for iteration in 0..<40 {
            let old: Double, new: Double
            if iteration.isMultiple(of: 2) {
                old = measurement(stack, iteration: iteration)
                new = measurement(grid, iteration: iteration)
            } else {
                new = measurement(grid, iteration: iteration)
                old = measurement(stack, iteration: iteration)
            }
            if iteration >= 10 { original.append(old); updated.append(new) }
        }
        original.sort(); updated.sort()
        print("WORK_TASK_GRID stack_p95_ms=\(original[28]) grid_p95_ms=\(updated[28])")
        XCTAssertLessThanOrEqual(updated[28], original[28] * 1.5 + 1)
    }

    private static func card(_ id: Int) -> some View {
        ConsoleConversationCardLabel(title: id.isMultiple(of: 2) ? String(repeating: "Long task title 中文 ", count: 20) : "Task \(id)",
            execution: .complete, needsAttention: false, status: "Completed", isSelected: false,
            isFixed: false, hasScheduledWake: false, isUnread: false, isActive: false) {
            Text(id.isMultiple(of: 3) ? "A longer summary\nwith several lines\nfor layout verification" : "Summary")
                .font(.caption).lineLimit(3)
        }
    }

    private static func probes(in view: NSView) -> [Int: NSView] {
        var result: [Int: NSView] = [:]
        if let name = view.identifier?.rawValue, name.hasPrefix("grid-cell-"),
           let id = Int(name.dropFirst("grid-cell-".count)) { result[id] = view }
        for child in view.subviews { result.merge(probes(in: child), uniquingKeysWith: { first, _ in first }) }
        return result
    }
}

private struct GridCellProbe: NSViewRepresentable {
    let id: Int
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = .init("grid-cell-\(id)")
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
