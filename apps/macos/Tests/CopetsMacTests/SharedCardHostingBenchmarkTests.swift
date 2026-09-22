import SwiftUI

// Feasibility probe, not the product card or a visual-parity implementation.
struct ProbeRow: Identifiable {
    let id: String
    var text: String
    var revision = 0
    var expanded = false
    var processing = true
}

struct SharedMessageCard: View {
    let row: ProbeRow
    let toggle: () -> Void
    let copy: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Corptie").font(.system(size: 11, weight: .medium))
                Spacer()
                if row.processing { Label("Processing", systemImage: "ellipsis.circle") }
            }
            SelectableBody(text: row.text)
            Button(action: toggle) {
                Label("工具执行过程", systemImage: row.expanded ? "chevron.down" : "chevron.right")
            }
            if row.expanded {
                Text("读取源码\n检查状态\n校验跨平台布局").font(.system(size: 11))
            }
            Button("复制") { copy(row.text) }
        }
        .font(.system(size: 10.5))
        .padding(10)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.1)))
        .accessibilityIdentifier("probe-card-\(row.id)")
    }
}

// Only the selectable text leaf is platform-specific; card composition is shared.
#if os(macOS)
import AppKit
struct SelectableBody: NSViewRepresentable {
    let text: String
    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView()
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.font = .systemFont(ofSize: 11, weight: .medium)
        return view
    }
    func updateNSView(_ view: NSTextView, context: Context) {
        if view.string != text { view.string = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0,
              let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height))
    }
}
#else
import UIKit
struct SelectableBody: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.font = .systemFont(ofSize: 11, weight: .medium)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
}

@MainActor
func makeProbeCell(row: ProbeRow, toggle: @escaping () -> Void, copy: @escaping (String) -> Void) -> UICollectionViewCell {
    let cell = UICollectionViewCell()
    cell.contentConfiguration = UIHostingConfiguration {
        SharedMessageCard(row: row, toggle: toggle, copy: copy)
    }.margins(.all, 0)
    return cell
}
#endif

#if os(macOS)
import XCTest
@testable import CorptieMac

private struct MeasuredAttributedLeaf: NSViewRepresentable {
    let text: NSAttributedString
    let size: CGSize
    func makeNSView(context: Context) -> NativeTimelineTextView {
        NativeTimelineTextView()
    }
    func updateNSView(_ view: NativeTimelineTextView, context: Context) {
        view.textStorage?.setAttributedString(text)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTimelineTextView, context: Context) -> CGSize? {
        size
    }
}

// Same production text parsing + measurement, fixed-size native text leaf.
// This is the measured-content variant of the shared composition proposal,
// not the complete product card (images/approvals/collaboration remain outside).
private struct MeasuredSharedCard: View {
    let layout: NativeTimelineLayoutCache.Layout
    let expanded: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Corptie").font(.system(size: 11, weight: .bold))
                Spacer()
                Text("Processing").font(.system(size: 10, weight: .semibold))
            }
            if layout.textHeight > 0 {
                MeasuredAttributedLeaf(text: layout.attributedText,
                    size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight))
                    .frame(width: layout.cardWidth - 20, height: layout.textHeight)
            }
            Button(action: {}) {
                Label("Working… · 3 steps", systemImage: expanded ? "chevron.down" : "chevron.right")
            }.buttonStyle(.plain).font(.system(size: 10.5))
        }
        .padding(10)
        .frame(width: layout.cardWidth)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.1)))
    }
}

@MainActor
private final class HostedProbeCell: NSTableCellView {
    let host: NSHostingView<MeasuredSharedCard>
    init(layout: NativeTimelineLayoutCache.Layout) {
        host = NSHostingView(rootView: MeasuredSharedCard(layout: layout, expanded: false))
        super.init(frame: .zero)
        host.autoresizingMask = [.width, .height]
        addSubview(host)
    }
    required init?(coder: NSCoder) { fatalError("unused") }
    override func layout() {
        host.frame = bounds
        super.layout()
    }
}

@MainActor
private final class ProbeTableDriver: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let shared: Bool
    let rows: [AppKitChatTimelineRow]
    let layouts: [NativeTimelineLayoutCache.Layout]
    var created = 0
    init(shared: Bool, rows: [AppKitChatTimelineRow], layouts: [NativeTimelineLayoutCache.Layout]) {
        self.shared = shared; self.rows = rows; self.layouts = layouts
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { layouts[row].rowHeight }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let identifier = NSUserInterfaceItemIdentifier(shared ? "shared" : "native")
        if shared {
            let cell: HostedProbeCell
            if let reused = tableView.makeView(withIdentifier: identifier, owner: nil) as? HostedProbeCell {
                cell = reused
            } else {
                cell = HostedProbeCell(layout: layouts[row]); cell.identifier = identifier; created += 1
            }
            cell.host.rootView = MeasuredSharedCard(layout: layouts[row], expanded: false)
            return cell
        }
        let cell: AppKitChatNativeTextCell
        if let reused = tableView.makeView(withIdentifier: identifier, owner: nil) as? AppKitChatNativeTextCell {
            cell = reused
        } else {
            cell = AppKitChatNativeTextCell(identifier: identifier); created += 1
        }
        cell.setContent(rows[row], availableWidth: 480, onToggleExpansion: { _ in })
        return cell
    }
}

/// Opt-in diagnostic, not a performance acceptance test. Candidate is a reduced
/// card, so a win cannot establish product parity; a material loss rejects it.
final class SharedCardHostingBenchmarkTests: XCTestCase {
    @MainActor
    func testCompareExistingNativeCellWithSharedPrototype() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CARD_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_CARD_BENCHMARK=1 for local rendering benchmark")
        }
        _ = NSApplication.shared
        let cell = AppKitChatNativeTextCell(identifier: .init("benchmark"))
        let host = NSHostingView(rootView: SharedMessageCard(
            row: .init(id: "stable", text: ""), toggle: {}, copy: { _ in }
        ).frame(width: 476))
        let nativeWindow = NSWindow(contentRect: .init(x: 0, y: 0, width: 500, height: 700),
                                    styleMask: [.borderless], backing: .buffered, defer: false)
        let sharedWindow = NSWindow(contentRect: .init(x: 0, y: 0, width: 500, height: 700),
                                    styleMask: [.borderless], backing: .buffered, defer: false)
        nativeWindow.contentView = cell
        sharedWindow.contentView = host
        nativeWindow.orderBack(nil)
        sharedWindow.orderBack(nil)
        defer { nativeWindow.orderOut(nil); sharedWindow.orderOut(nil) }
        let paragraph = "中文 mixed streaming words https://example.com/path. "
        let workloads: [(String, String)] = [
            ("short", String(repeating: paragraph, count: 3)),
            ("long", String(repeating: paragraph, count: 200))
        ]
        for (name, base) in workloads {
            var nativeTimes: [Double] = []
            var sharedTimes: [Double] = []
            for iteration in 0..<120 {
                let text = base + " token-\(iteration)"
                let row = AppKitChatTimelineRow(
                    id: "stable", contentRevision: iteration, nativeText: text, copyText: text,
                    nativeStyle: .agent, title: "Corptie", metadata: "Processing",
                    expandableTurnId: "turn", isExpanded: false, processCount: 3,
                    processState: .running
                )
                let probe = ProbeRow(id: "stable", text: text, revision: iteration)
                // These fixtures both saturate the native 476pt card width.
                let nativeWork: () -> Void = {
                    cell.setContent(row, availableWidth: 480, onToggleExpansion: { _ in })
                    cell.layoutSubtreeIfNeeded()
                    _ = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 480).rowHeight
                }
                let sharedWork: () -> Void = {
                    host.rootView = SharedMessageCard(row: probe, toggle: {}, copy: { _ in }).frame(width: 476)
                    host.layoutSubtreeIfNeeded()
                    let height = host.fittingSize.height
                    XCTAssertTrue(height.isFinite && height > 0)
                }
                func measure(_ work: () -> Void) -> Double {
                    autoreleasepool {
                        let start = ProcessInfo.processInfo.systemUptime
                        work()
                        return (ProcessInfo.processInfo.systemUptime - start) * 1_000
                    }
                }
                let nativeMS: Double
                let sharedMS: Double
                if iteration.isMultiple(of: 2) {
                    nativeMS = measure(nativeWork); sharedMS = measure(sharedWork)
                } else {
                    sharedMS = measure(sharedWork); nativeMS = measure(nativeWork)
                }
                if iteration >= 20 {
                    nativeTimes.append(nativeMS); sharedTimes.append(sharedMS)
                }
                // Outside both timed intervals: process deferred display work.
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.001))
            }
            nativeTimes.sort(); sharedTimes.sort()
            print("CARD_BENCH \(name) n=100 native_p50=\(nativeTimes[50]) native_p95=\(nativeTimes[95]) shared_p50=\(sharedTimes[50]) shared_p95=\(sharedTimes[95])")
        }
    }

    @MainActor
    func testSameProductionRichTextPipeline() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CARD_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_CARD_BENCHMARK=1 for local rendering benchmark")
        }
        _ = NSApplication.shared
        func row(_ text: String, _ iteration: Int, isProcess: Bool = false) -> AppKitChatTimelineRow {
            let expanded = isProcess && iteration.isMultiple(of: 2)
            let steps: [NativeExecutionTimelineStep] = expanded ? (0..<20).map { index in
                .init(id: "step-\(index)", kind: .action, state: .running,
                      title: "执行工具 \(index)", detail: "读取结果 中文 mixed output \(iteration)")
            } : []
            return AppKitChatTimelineRow(id: "rich-stable", contentRevision: iteration,
                nativeText: isProcess && !expanded ? "" : text,
                copyText: isProcess && !expanded ? "" : text, nativeStyle: isProcess ? .process : .agent,
                title: "", metadata: "", expandableTurnId: isProcess ? "turn" : nil,
                isExpanded: expanded, processCount: isProcess ? 20 : nil,
                processState: .running, processSteps: steps, showsHeader: false)
        }
        let fixture = "## 标题 Heading\n正文 **bold** 中文 mixed text and [link](https://example.com).\n- first\n- second\n> quote\n```swift\nlet value = 42\n```\n"
        for (name, base) in [("rich-short", fixture), ("rich-long", String(repeating: fixture, count: 70)), ("process-toggle", String(repeating: "工具执行结果 中文 mixed words\n", count: 20))] {
            let sharedCache = NativeTimelineLayoutCache()
            let cell = AppKitChatNativeTextCell(identifier: .init("same-pipeline"))
            let seed = sharedCache.layout(for: row("seed", 0), columnWidth: 480)
            let host = NSHostingView(rootView: MeasuredSharedCard(layout: seed, expanded: false))
            let nativeWindow = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
            let sharedWindow = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
            let nativeContainer = NSView(frame: nativeWindow.contentView!.bounds)
            nativeContainer.addSubview(cell)
            nativeWindow.contentView = nativeContainer; sharedWindow.contentView = host
            nativeWindow.orderBack(nil); sharedWindow.orderBack(nil)
            var nativeTimes: [Double] = [], sharedTimes: [Double] = []
            for iteration in 0..<120 {
                let model = row(base + "\nstream token-\(iteration)", iteration, isProcess: name == "process-toggle")
                // Both paths share production's parsed-text cache. Prime only
                // that common stage; each path measures its own width/height.
                _ = NativeMarkdownTextCache.shared.value(text: model.nativeText, style: model.nativeStyle)
                var nativeHeight: CGFloat = 0, sharedHeight: CGFloat = 0
                let nativeWork: () -> Void = {
                    // Cell setContent uses the production singleton layout cache.
                    // Its first call for this text is a miss.
                    let layout = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 480)
                    cell.setContent(model, availableWidth: 480, onToggleExpansion: { _ in })
                    cell.frame = NSRect(x: 0, y: 0, width: 480, height: layout.rowHeight)
                    cell.layoutSubtreeIfNeeded()
                    nativeHeight = layout.textHeight
                }
                let sharedWork: () -> Void = {
                    let layout = sharedCache.layout(for: model, columnWidth: 480)
                    host.rootView = MeasuredSharedCard(layout: layout, expanded: model.isExpanded)
                    host.layoutSubtreeIfNeeded()
                    _ = host.fittingSize
                    sharedHeight = layout.textHeight
                }
                func timed(_ operation: () -> Void) -> Double {
                    autoreleasepool {
                        let start = ProcessInfo.processInfo.systemUptime
                        operation()
                        return (ProcessInfo.processInfo.systemUptime - start) * 1_000
                    }
                }
                let nativeMS: Double, sharedMS: Double
                if iteration.isMultiple(of: 2) {
                    nativeMS = timed(nativeWork); sharedMS = timed(sharedWork)
                } else {
                    sharedMS = timed(sharedWork); nativeMS = timed(nativeWork)
                }
                XCTAssertEqual(nativeHeight, sharedHeight)
                if iteration >= 20 { nativeTimes.append(nativeMS); sharedTimes.append(sharedMS) }
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.001))
            }
            nativeTimes.sort(); sharedTimes.sort()
            print("CARD_BENCH \(name) n=100 native_p50=\(nativeTimes[50]) native_p95=\(nativeTimes[95]) shared_p50=\(sharedTimes[50]) shared_p95=\(sharedTimes[95])")
            nativeWindow.orderOut(nil); sharedWindow.orderOut(nil)
        }
    }

    @MainActor
    func testNativeTableScrollWithSharedCells() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CARD_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_CARD_BENCHMARK=1 for local rendering benchmark")
        }
        _ = NSApplication.shared
        let rows = (0..<1_000).map { index in
            let text = String(repeating: "**中文** mixed words and `code`.\n", count: index.isMultiple(of: 50) ? 100 : 4)
            return AppKitChatTimelineRow(id: "row-\(index)", contentRevision: 1,
                nativeText: text, copyText: text, nativeStyle: .agent,
                title: "Corptie", metadata: "Processing", expandableTurnId: nil,
                isExpanded: false, processCount: 3, processState: .running)
        }
        // Both paths use the same warm parsed-content and height cache here.
        // This isolates visible-cell reuse/layout/drawing, not cold history load.
        let layouts = rows.map { NativeTimelineLayoutCache.shared.layout(for: $0, columnWidth: 480) }
        func setup(_ driver: ProbeTableDriver) -> (NSWindow, NSTableView) {
            let table = NSTableView(frame: .init(x: 0, y: 0, width: 480, height: 600))
            let column = NSTableColumn(identifier: .init("body")); column.width = 480
            table.addTableColumn(column); table.headerView = nil
            table.dataSource = driver; table.delegate = driver
            table.intercellSpacing = .zero
            let scroll = NSScrollView(frame: .init(x: 0, y: 0, width: 480, height: 600))
            scroll.documentView = table; scroll.hasVerticalScroller = true
            let window = NSWindow(contentRect: scroll.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = scroll; window.orderBack(nil)
            table.reloadData(); window.contentView?.layoutSubtreeIfNeeded()
            return (window, table)
        }
        let native = ProbeTableDriver(shared: false, rows: rows, layouts: layouts)
        let shared = ProbeTableDriver(shared: true, rows: rows, layouts: layouts)
        let (nw, nt) = setup(native), (sw, st) = setup(shared)
        defer { nw.orderOut(nil); sw.orderOut(nil) }
        var nTimes: [Double] = [], sTimes: [Double] = []
        func timed(_ window: NSWindow, _ table: NSTableView, _ target: Int) -> Double {
            autoreleasepool {
                let start = ProcessInfo.processInfo.systemUptime
                table.scrollRowToVisible(target)
                window.contentView?.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                return (ProcessInfo.processInfo.systemUptime - start) * 1_000
            }
        }
        for iteration in 0..<120 {
            let target = (iteration * 17) % 990
            let n: Double, s: Double
            if iteration.isMultiple(of: 2) {
                n = timed(nw, nt, target); s = timed(sw, st, target)
            } else {
                s = timed(sw, st, target); n = timed(nw, nt, target)
            }
            if iteration >= 20 { nTimes.append(n); sTimes.append(s) }
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.001))
        }
        nTimes.sort(); sTimes.sort()
        XCTAssertGreaterThan(native.created, 0); XCTAssertGreaterThan(shared.created, 0)
        XCTAssertLessThan(native.created, 1_000); XCTAssertLessThan(shared.created, 1_000)
        print("CARD_BENCH scroll-warm-1000 n=100 native_p50=\(nTimes[50]) native_p95=\(nTimes[95]) shared_p50=\(sTimes[50]) shared_p95=\(sTimes[95]) native_cells=\(native.created) shared_cells=\(shared.created)")
    }
}
#endif
