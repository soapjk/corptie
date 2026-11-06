import AppKit
import SwiftUI
import ApplicationServices
import CorptieConversation
import CorptieClientCore
import Observation
@preconcurrency import ScreenCaptureKit
@preconcurrency import Vision

private struct HarnessFailure: Error { let message: String }
@MainActor @Observable private final class RollbackProbe { var confirmed = false }
private struct RollbackHarnessView: View {
    let preview: ClientWorktreeRollbackPreview
    let probe: RollbackProbe
    var body: some View {
        VStack {
            WorktreeRollbackReviewView(prepare: { (preview, false) }, confirm: { review, discard, additional in
                guard review == "isolated-review", discard, !additional else { throw HarnessFailure(message: "Wrong rollback confirmation.") }
                probe.confirmed = true
            })
            Text(probe.confirmed ? "ROLLBACK_CONFIRMED" : "ROLLBACK_PENDING").font(.caption.monospaced())
        }.frame(width: 720, height: 650)
    }
}
private func require<T>(_ value: T?) throws -> T {
    guard let value else { throw HarnessFailure(message: "Required screen or window evidence is missing.") }
    return value
}

private struct ConcurrentActivity: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            Rectangle().fill(.blue).frame(width: 8, height: 8)
                .offset(x: (sin(context.date.timeIntervalSinceReferenceDate * 6) + 1) * 36)
                .frame(width: 80, height: 8, alignment: .leading)
        }
    }
}

@MainActor private final class HarnessDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            do {
                if CommandLine.arguments.contains("--rollback") {
                    try await DiagnosticInteractionHarness.runRollbackScenario()
                } else {
                    try await DiagnosticInteractionHarness.runScenario()
                }
                Darwin.exit(0)
            } catch {
                print("DIAGNOSTIC_INTERACTION_FAILED=\(error)")
                Darwin.exit(1)
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main @MainActor private enum DiagnosticInteractionHarness {
    static func main() {
        let app = NSApplication.shared
        let delegate = HarnessDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            print("DIAGNOSTIC_INTERACTION_FAILED=Native UI verification timed out.")
            Darwin.exit(2)
        }
        withExtendedLifetime(delegate) { app.run() }
    }

    static func runRollbackScenario() async throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw HarnessFailure(message: "Existing accessibility and capture permissions are required.")
        }
        let previousFrontmost = NSWorkspace.shared.frontmostApplication
        let previousPointer = CGEvent(source: nil)?.location
        let probe = RollbackProbe()
        let preview = try JSONDecoder().decode(ClientWorktreeRollbackPreview.self, from: Data(#"{"id":"isolated-review","jobId":"isolated-job","targets":[{"worktreeId":"main","path":"/isolated/main","branchName":"main","baselineHead":"before-this-round","currentHead":"resolved-conflict-head","operation":"merge","changedFiles":["UU shared.txt"],"ownedCommits":["round-merge"],"additionalCommits":[],"requiresPreservation":true,"published":false,"mode":"restore_baseline"}]}"#.utf8))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 720, height: 650),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Corptie isolated rollback interaction test"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: RollbackHarnessView(preview: preview, probe: probe))
        window.makeKeyAndOrderFront(nil); window.orderFrontRegardless(); NSApplication.shared.activate()
        defer {
            window.close(); _ = previousFrontmost?.activate(options: [])
            if let previousPointer { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                mouseCursorPosition: previousPointer, mouseButton: .left)?.post(tap: .cghidEventTap) }
        }
        try await Task.sleep(for: .milliseconds(300))
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let captured = try require(content.windows.first { $0.windowID == CGWindowID(window.windowNumber) })
        let filter = SCContentFilter(desktopIndependentWindow: captured)
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width * 2); config.height = Int(window.frame.height * 2)
        config.ignoreShadowsSingleWindow = true; config.showsCursor = false
        let screenTop = try require(NSScreen.screens.first).frame.maxY
        func point(_ box: CGRect) -> CGPoint { CGPoint(x: window.frame.minX + box.midX * window.frame.width,
            y: screenTop - (window.frame.minY + box.midY * window.frame.height)) }
        let first = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let labels = try await Task.detached { try Self.recognize(first) }.value
        print("ROLLBACK_RENDERED_LABELS=\(labels.map(\.0))")
        let confirm = try require(labels.first { $0.0.contains("确认取消并回滚") })
        print("ROLLBACK_CONFIRM_POINT=\(point(confirm.1)) WINDOW=\(window.frame)")
        try postMouseClick(point(confirm.1), window: window)
        try await Task.sleep(for: .milliseconds(80))
        guard !probe.confirmed else { throw HarnessFailure(message: "Rollback executed without edit-discard confirmation.") }
        let checkbox = try require(labels.first { $0.0.contains("确认放弃") })
        print("ROLLBACK_CHECKBOX_POINT=\(point(checkbox.1))")
        try postMouseClick(CGPoint(x: window.frame.minX + 28, y: point(checkbox.1).y), window: window)
        try await Task.sleep(for: .milliseconds(80))
        let started = ProcessInfo.processInfo.systemUptime
        try postMouseClick(point(confirm.1), window: window)
        var visibleAt: Double?
        for attempt in 0..<10 {
            try await Task.sleep(for: .milliseconds(30))
            let frame = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let capturedAt = ProcessInfo.processInfo.systemUptime
            let rows = try await Task.detached { try Self.recognize(frame) }.value
            if attempt == 0 { print("ROLLBACK_AFTER_LABELS=\(rows.map(\.0)) confirmed=\(probe.confirmed)") }
            if rows.contains(where: { $0.0.uppercased().filter(\.isLetter).contains("ROLLBACKCONFIRMED") }) {
                visibleAt = capturedAt; break
            }
        }
        let elapsed = (try require(visibleAt) - started) * 1_000
        guard probe.confirmed, elapsed < 1_000 else { throw HarnessFailure(message: "Rollback confirmation did not reach the screen.") }
        print("ROLLBACK_MOUSE_TO_VISIBLE_MS=\(elapsed)")
        print("ROLLBACK_INTERACTION_PASSED")
    }

    static func runScenario() async throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw HarnessFailure(message: "Existing accessibility and capture permissions are required; no permission prompt was requested.")
        }
        let previousFrontmost = NSWorkspace.shared.frontmostApplication
        let previousPointer = CGEvent(source: nil)?.location
        let full = "VISIBLE_DIAGNOSTIC_LINE\n" + (0..<12_000)
            .map { "DIAGNOSTIC_ROW_\($0) 👨‍👩‍👧‍👦\n" }.joined() + "LAST_DETAIL"
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 640, height: 420),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Corptie isolated diagnostic interaction test"
        window.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: VStack(alignment: .leading, spacing: 12) {
            ConcurrentActivity()
            WorktreeErrorDetailsView(full, summary: "Merge failed: parent → main")
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding())
        hosting.frame = NSRect(x: 0, y: 0, width: 640, height: 420)
        hosting.autoresizingMask = [.width, .height]
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApplication.shared.activate()
        defer {
            window.close(); _ = previousFrontmost?.activate(options: [])
            if let previousPointer {
                CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: previousPointer,
                        mouseButton: .left)?.post(tap: .cghidEventTap)
            }
        }
        hosting.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        let screenTop = try require(NSScreen.screens.first).frame.maxY
        try Self.postMouseClick(CGPoint(x: window.frame.midX, y: screenTop - window.frame.maxY + 12), window: window)
        try await Task.sleep(for: .milliseconds(40))
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let capturedWindow = try require(content.windows.first { $0.windowID == CGWindowID(window.windowNumber) })
        let filter = SCContentFilter(desktopIndependentWindow: capturedWindow)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(window.frame.width * 2); configuration.height = Int(window.frame.height * 2)
        configuration.showsCursor = false; configuration.ignoreShadowsSingleWindow = true
        let before = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        let activityRegion = CGRect(x: 32, y: Double(before.height) - hosting.frame.height * 2 + 32,
                                    width: 160, height: 16)
        let activityBefore = try require(before.cropping(to: activityRegion)?.dataProvider?.data) as Data
        try await Task.sleep(for: .milliseconds(100))
        let animated = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard let activityPixels = animated.cropping(to: activityRegion)?.dataProvider?.data,
              (activityPixels as Data) != activityBefore else {
            throw HarnessFailure(message: "The concurrent animation did not reach the captured screen.")
        }
        let labels = try await Task.detached { try Self.recognize(before) }.value
        print("DIAGNOSTIC_RENDERED_LABELS=\(labels.map(\.0))")
        let button = try require(labels.first { $0.0 == "完整错误详情" })
        let point = CGPoint(x: window.frame.minX + button.1.midX * window.frame.width,
                            y: screenTop - (window.frame.minY + button.1.midY * window.frame.height))
        let detailRegion = CGRect(x: 0, y: Double(before.height) * 0.35,
                                  width: Double(before.width), height: Double(before.height) * 0.55)
        let oldPixels = try require(before.cropping(to: detailRegion)?.dataProvider?.data) as Data
        let started = ProcessInfo.processInfo.systemUptime
        print("DIAGNOSTIC_MOUSE_POINT=\(point) active=\(NSApplication.shared.isActive)")
        try Self.postMouseClick(point, window: window)
        var visible = false, visibleAt = started
        for attempt in 0..<8 {
            try await Task.sleep(for: .milliseconds(20))
            let frame = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let capturedAt = ProcessInfo.processInfo.systemUptime
            guard let pixels = frame.cropping(to: detailRegion)?.dataProvider?.data,
                  (pixels as Data) != oldPixels else { continue }
            let rows = try await Task.detached { try Self.recognize(frame) }.value
            if attempt == 0 { print("DIAGNOSTIC_AFTER_LABELS=\(rows.map(\.0))") }
            if rows.contains(where: { $0.0.uppercased().filter(\.isLetter).contains("VISIBLEDIAGNOSTICLINE") }) {
                visible = true; visibleAt = capturedAt; break
            }
        }
        let elapsed = (visibleAt - started) * 1_000
        print("DIAGNOSTIC_MOUSE_TO_VISIBLE_MS=\(elapsed)")
        guard visible, elapsed < 1_000 else {
            throw HarnessFailure(message: "Actual diagnostic screen presentation was not observed within one second.")
        }
        let scrollPoint = CGPoint(x: window.frame.midX, y: point.y + 120)
        try Self.requireOwnWindow(at: scrollPoint, window: window)
        let scroll = try require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                                         wheel1: -1_200, wheel2: 0, wheel3: 0))
        try require(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                            mouseCursorPosition: scrollPoint, mouseButton: .left)).post(tap: .cghidEventTap)
        scroll.location = scrollPoint
        scroll.flags = []
        scroll.post(tap: .cghidEventTap)
        try await Task.sleep(for: .milliseconds(150))
        let bottom = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        let bottomRows = try await Task.detached { try Self.recognize(bottom) }.value
        guard bottomRows.contains(where: {
            let value = $0.0.uppercased().filter { $0.isLetter || $0.isNumber }
            return value.contains("DIAGNOSTICROW") && (Int(value.filter(\.isNumber)) ?? 0) > 40
        }), !bottomRows.contains(where: { $0.0.uppercased().filter(\.isLetter).contains("VISIBLEDIAGNOSTICLINE") }) else {
            print("DIAGNOSTIC_SCROLL_LABELS=\(bottomRows.map(\.0))")
            throw HarnessFailure(message: "Native wheel scrolling did not display later virtualized diagnostic rows.")
        }
        print("DIAGNOSTIC_LONG_SCROLL_PASSED")
        print("DIAGNOSTIC_CONCURRENT_ANIMATION_PASSED")
        print("DIAGNOSTIC_INTERACTION_PASSED")
    }

    @MainActor private static func postMouseClick(_ point: CGPoint, window: NSWindow) throws {
        try requireOwnWindow(at: point, window: window)
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            let event = try require(CGEvent(mouseEventSource: nil, mouseType: type,
                                            mouseCursorPosition: point, mouseButton: .left))
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
    }

    @MainActor private static func requireOwnWindow(at point: CGPoint, window: NSWindow) throws {
        let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
        let hit = windows.first { entry in
            guard let bounds = entry[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return frame.contains(point)
        }
        guard hit?[kCGWindowNumber as String] as? Int == window.windowNumber else {
            throw NSError(domain: "CorptieInteractionTest", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Mouse point \(point) hit window \(hit?[kCGWindowNumber as String] ?? -1), expected \(window.windowNumber)."])
        }
    }

    nonisolated private static func recognize(_ image: CGImage) throws -> [(String, CGRect)] {
        let request = VNRecognizeTextRequest()
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).flatMap { observation -> [(String, CGRect)] in
            guard let candidate = observation.topCandidates(1).first else { return [] }
            var rows = [(candidate.string, observation.boundingBox)]
            if let range = candidate.string.range(of: "完整错误详情"),
               let box = try? candidate.boundingBox(for: range) {
                rows.insert(("完整错误详情", box.boundingBox), at: 0)
            }
            return rows
        }
    }

}
