import AppKit
import SwiftUI

@main
enum MacProbe {
    @MainActor static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        var row = ProbeRow(id: "stable", text: "中英文 mixed content https://example.com\n第二行")
        var toggles = 0
        var copied = ""
        func card() -> SharedMessageCard {
            SharedMessageCard(row: row, toggle: { toggles += 1 }, copy: { copied = $0 })
        }
        let host = NSHostingView(rootView: card().frame(width: 460))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 700),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        func height(_ width: CGFloat) -> CGFloat {
            host.rootView = card().frame(width: width)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.005))
            let value = host.fittingSize.height
            precondition(value.isFinite && value > 0)
            return value
        }
        let short = height(460)
        row.expanded = true
        let expanded = height(460)
        precondition(expanded > short, "Expansion must increase height")
        row.text = String(repeating: "长文本 streaming 中文 mixed words and a link https://example.com/path. ", count: 100)
        let long = height(460)
        let narrow = height(240)
        precondition(long > expanded && narrow > long, "Text must reflow")
        card().toggle()
        card().copy(row.text)
        precondition(toggles == 1 && copied == row.text)
        var samples: [Double] = []
        for index in 0..<100 {
            row.revision += 1
            row.text += " \(index)"
            let start = ProcessInfo.processInfo.systemUptime
            _ = height(460)
            samples.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
            precondition(row.id == "stable" && row.expanded)
        }
        row.text = "完成"
        row.processing = false
        row.expanded = false
        let final = height(460)
        precondition(final < long)
        host.frame = NSRect(x: 0, y: 0, width: 460, height: final)
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("No bitmap") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        precondition(bitmap.pixelsWide > 0 && bitmap.pixelsHigh > 0)
        samples.sort()
        print("PASS macOS NSHostingView shared card: finite sizing, expansion, long text, width reflow, callback wiring, 100 stable-ID updates, collapse, bitmap rendering")
        print("heights short=\(short) expanded=\(expanded) long=\(long) narrow=\(narrow) final=\(final)")
        print("single-card update+measurement milliseconds p50=\(samples[50]) p95=\(samples[95]); includes 5ms runloop wait, NOT scrolling benchmark")
    }
}
