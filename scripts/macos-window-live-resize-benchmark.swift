#!/usr/bin/env swift

import AppKit
import ApplicationServices
import Foundation

private struct Options {
    var pid: pid_t?
    var duration = 6.0
    var events = 360
    var cycles = 2.0
    var widthAmplitude = 180.0
    var heightAmplitude = 110.0
    var pollRate = 240.0
    var tabIdentifier: String?
    var trackedIdentifier: String?
    var trackRate = 20.0

    init(arguments: [String]) throws {
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            guard index + 1 < arguments.count else {
                throw BenchmarkError.invalidArgument("Missing value for \(argument)")
            }
            let value = arguments[index + 1]
            switch argument {
            case "--pid": pid = pid_t(value)
            case "--duration": duration = try Self.positiveDouble(value, name: argument)
            case "--events": events = try Self.positiveInt(value, name: argument)
            case "--cycles": cycles = try Self.positiveDouble(value, name: argument)
            case "--width-amplitude": widthAmplitude = try Self.nonnegativeDouble(value, name: argument)
            case "--height-amplitude": heightAmplitude = try Self.nonnegativeDouble(value, name: argument)
            case "--poll-rate": pollRate = try Self.positiveDouble(value, name: argument)
            case "--tab-identifier": tabIdentifier = value
            case "--track-identifier": trackedIdentifier = value
            case "--track-rate": trackRate = try Self.positiveDouble(value, name: argument)
            default: throw BenchmarkError.invalidArgument("Unknown argument: \(argument)")
            }
            index += 2
        }
        guard pid != nil else { throw BenchmarkError.invalidArgument("--pid is required") }
        guard events >= 2 else { throw BenchmarkError.invalidArgument("--events must be at least 2") }
    }

    private static func positiveDouble(_ value: String, name: String) throws -> Double {
        guard let parsed = Double(value), parsed > 0 else {
            throw BenchmarkError.invalidArgument("\(name) must be positive")
        }
        return parsed
    }

    private static func nonnegativeDouble(_ value: String, name: String) throws -> Double {
        guard let parsed = Double(value), parsed >= 0 else {
            throw BenchmarkError.invalidArgument("\(name) must be nonnegative")
        }
        return parsed
    }

    private static func positiveInt(_ value: String, name: String) throws -> Int {
        guard let parsed = Int(value), parsed > 0 else {
            throw BenchmarkError.invalidArgument("\(name) must be positive")
        }
        return parsed
    }
}

private enum BenchmarkError: Error, CustomStringConvertible {
    case invalidArgument(String)
    case accessibility(String)
    case event(String)

    var description: String {
        switch self {
        case .invalidArgument(let message), .accessibility(let message), .event(let message): message
        }
    }
}

private final class DragState: @unchecked Sendable {
    private let lock = NSLock()
    private var desiredSize = CGSize.zero
    private var sentEvents = 0
    private var finished = false

    func update(desiredSize: CGSize, sentEvents: Int) {
        lock.lock()
        self.desiredSize = desiredSize
        self.sentEvents = sentEvents
        lock.unlock()
    }

    func finish() {
        lock.lock()
        finished = true
        lock.unlock()
    }

    func snapshot() -> (desiredSize: CGSize, sentEvents: Int, finished: Bool) {
        lock.lock()
        let result = (desiredSize, sentEvents, finished)
        lock.unlock()
        return result
    }
}

private func visibleWindow(pid: pid_t) throws -> (number: CGWindowID, bounds: CGRect) {
    let entries = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] ?? []
    for entry in entries {
        guard let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
              ownerPID == Int(pid),
              let number = entry[kCGWindowNumber as String] as? CGWindowID,
              let dictionary = entry[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              bounds.width >= 300,
              bounds.height >= 120 else { continue }
        return (number, bounds)
    }
    throw BenchmarkError.accessibility("Unable to find a visible window for pid \(pid)")
}

private func windowBounds(number: CGWindowID) throws -> CGRect {
    guard let entry = (CGWindowListCopyWindowInfo([.optionIncludingWindow], number)
        as? [[String: Any]])?.first,
          let dictionary = entry[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else {
        throw BenchmarkError.accessibility("Unable to read WindowServer geometry")
    }
    return bounds
}

private func copyAttribute(_ name: CFString, from element: AXUIElement) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

private func accessibilityWindow(application: AXUIElement) throws -> AXUIElement {
    if let focused = copyAttribute(kAXFocusedWindowAttribute as CFString, from: application),
       CFGetTypeID(focused) == AXUIElementGetTypeID() {
        return unsafeDowncast(focused, to: AXUIElement.self)
    }
    guard let windows = copyAttribute(kAXWindowsAttribute as CFString, from: application) as? [AXUIElement],
          let first = windows.first else {
        throw BenchmarkError.accessibility("Unable to access the main window")
    }
    return first
}

private func accessibilityPoint(_ attribute: CFString, element: AXUIElement) throws -> CGPoint {
    guard let raw = copyAttribute(attribute, from: element),
          CFGetTypeID(raw) == AXValueGetTypeID() else {
        throw BenchmarkError.accessibility("Unable to read AX point")
    }
    var point = CGPoint.zero
    guard AXValueGetValue(unsafeDowncast(raw, to: AXValue.self), .cgPoint, &point) else {
        throw BenchmarkError.accessibility("Invalid AX point")
    }
    return point
}

private func accessibilitySize(element: AXUIElement) throws -> CGSize {
    guard let raw = copyAttribute(kAXSizeAttribute as CFString, from: element),
          CFGetTypeID(raw) == AXValueGetTypeID() else {
        throw BenchmarkError.accessibility("Unable to read AX size")
    }
    var size = CGSize.zero
    guard AXValueGetValue(unsafeDowncast(raw, to: AXValue.self), .cgSize, &size) else {
        throw BenchmarkError.accessibility("Invalid AX size")
    }
    return size
}

private func findElement(identifier: String, below root: AXUIElement) -> AXUIElement? {
    var queue = [root]
    var visited = 0
    while !queue.isEmpty, visited < 10_000 {
        let candidate = queue.removeFirst()
        visited += 1
        if copyAttribute(kAXIdentifierAttribute as CFString, from: candidate) as? String == identifier {
            return candidate
        }
        if let children = copyAttribute(kAXChildrenAttribute as CFString, from: candidate) as? [AXUIElement] {
            queue.append(contentsOf: children)
        }
    }
    return nil
}

private func percentile(_ values: [Double], _ fraction: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let index = min(sorted.count - 1, Int(ceil(Double(sorted.count) * fraction)) - 1)
    return sorted[max(0, index)]
}

private func forceFrontmost(pid: pid_t) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [
        "-e",
        "tell application \"System Events\" to set frontmost of first process whose unix id is \(pid) to true"
    ]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw BenchmarkError.accessibility("Unable to make pid \(pid) frontmost")
    }
}

private func postMouseEvent(
    source: CGEventSource,
    type: CGEventType,
    point: CGPoint,
    button: CGMouseButton = .left
) throws {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw BenchmarkError.event("Unable to create mouse event")
    }
    event.post(tap: .cghidEventTap)
}

private func run() throws {
    let options = try Options(arguments: CommandLine.arguments)
    let pid = options.pid!
    guard let application = NSRunningApplication(processIdentifier: pid) else {
        throw BenchmarkError.invalidArgument("No running application for pid \(pid)")
    }
    application.activate(options: [.activateAllWindows])
    Thread.sleep(forTimeInterval: 0.3)

    let accessibilityApplication = AXUIElementCreateApplication(pid)
    if let tabIdentifier = options.tabIdentifier {
        guard let tab = findElement(identifier: tabIdentifier, below: accessibilityApplication),
              AXUIElementPerformAction(tab, kAXPressAction as CFString) == .success else {
            throw BenchmarkError.accessibility("Unable to select tab \(tabIdentifier)")
        }
        Thread.sleep(forTimeInterval: 0.4)
    }

    let window = try visibleWindow(pid: pid)
    let mainWindow = try accessibilityWindow(application: accessibilityApplication)
    guard AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString) == .success else {
        throw BenchmarkError.accessibility("Unable to raise the target window")
    }
    application.activate(options: [.activateAllWindows])
    try forceFrontmost(pid: pid)
    Thread.sleep(forTimeInterval: 0.2)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw BenchmarkError.accessibility("Target pid \(pid) did not become frontmost")
    }
    let initialPosition = try accessibilityPoint(kAXPositionAttribute as CFString, element: mainWindow)
    let initialSize = try accessibilitySize(element: mainWindow)
    let trackedElement = options.trackedIdentifier.flatMap {
        findElement(identifier: $0, below: accessibilityApplication)
    }
    if options.trackedIdentifier != nil, trackedElement == nil {
        throw BenchmarkError.accessibility(
            "Unable to track element \(options.trackedIdentifier!)"
        )
    }
    let initialTrackedPosition = try trackedElement.map {
        try accessibilityPoint(kAXPositionAttribute as CFString, element: $0)
    }
    let initialTrackedSize = try trackedElement.map {
        try accessibilitySize(element: $0)
    }
    let corner = CGPoint(
        x: initialPosition.x + initialSize.width - 1,
        y: initialPosition.y + initialSize.height - 1
    )
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        throw BenchmarkError.event("Unable to create HID event source")
    }

    try postMouseEvent(source: source, type: .mouseMoved, point: corner)
    Thread.sleep(forTimeInterval: 0.25)
    try postMouseEvent(source: source, type: .leftMouseDown, point: corner)
    Thread.sleep(forTimeInterval: 0.1)

    let state = DragState()
    state.update(desiredSize: initialSize, sentEvents: 0)
    let start = ProcessInfo.processInfo.systemUptime
    let sendInterval = options.duration / Double(options.events - 1)

    DispatchQueue.global(qos: .userInteractive).async {
        var lastPoint = corner
        for index in 0..<options.events {
            let phase = (Double(index) / Double(options.events - 1)) * options.cycles * 2 * Double.pi
            let delta = CGSize(
                width: sin(phase) * options.widthAmplitude,
                height: sin(phase) * options.heightAmplitude
            )
            let desired = CGSize(width: initialSize.width + delta.width, height: initialSize.height + delta.height)
            lastPoint = CGPoint(x: corner.x + delta.width, y: corner.y + delta.height)
            state.update(desiredSize: desired, sentEvents: index + 1)
            try? postMouseEvent(
                source: source,
                type: .leftMouseDragged,
                point: lastPoint
            )
            let deadline = start + Double(index + 1) * sendInterval
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
        }
        try? postMouseEvent(source: source, type: .leftMouseUp, point: lastPoint)
        state.finish()
    }

    var lastSize = initialSize
    var observedChanges = 0
    var uniqueSizes = Set<String>()
    var changeTimes: [Double] = []
    var lagSamples: [Double] = []
    var trackedPositionDrift: [Double] = []
    var trackedSizeDrift: [Double] = []
    var nextTrackTime = start
    let pollInterval = 1.0 / options.pollRate
    while true {
        let snapshot = state.snapshot()
        let observed = try windowBounds(number: window.number).size
        let now = ProcessInfo.processInfo.systemUptime
        lagSamples.append(hypot(observed.width - snapshot.desiredSize.width, observed.height - snapshot.desiredSize.height))
        if observed != lastSize {
            lastSize = observed
            observedChanges += 1
            uniqueSizes.insert("\(Int(observed.width))x\(Int(observed.height))")
            changeTimes.append(now)
        }
        if let trackedElement,
           let initialTrackedPosition,
           let initialTrackedSize,
           now >= nextTrackTime {
            let trackedPosition = try accessibilityPoint(
                kAXPositionAttribute as CFString,
                element: trackedElement
            )
            let trackedSize = try accessibilitySize(element: trackedElement)
            trackedPositionDrift.append(hypot(
                trackedPosition.x - initialTrackedPosition.x,
                trackedPosition.y - initialTrackedPosition.y
            ))
            trackedSizeDrift.append(hypot(
                trackedSize.width - initialTrackedSize.width,
                trackedSize.height - initialTrackedSize.height
            ))
            nextTrackTime += 1.0 / options.trackRate
        }
        if snapshot.finished { break }
        Thread.sleep(forTimeInterval: pollInterval)
    }

    Thread.sleep(forTimeInterval: 0.3)
    let finalSize = try windowBounds(number: window.number).size
    var intervals: [Double] = []
    if changeTimes.count > 1 {
        for index in 1..<changeTimes.count {
            intervals.append((changeTimes[index] - changeTimes[index - 1]) * 1_000)
        }
    }
    let elapsed = ProcessInfo.processInfo.systemUptime - start
    let meanLag = lagSamples.reduce(0, +) / Double(max(1, lagSamples.count))
    let geometryRate = Double(observedChanges) / options.duration
    print(
        String(
            format: "real_live pid=%d tab=%@ seconds=%.2f sent=%d observed=%d unique=%d geometry_hz=%.2f p50_interval_ms=%.2f p95_interval_ms=%.2f max_interval_ms=%.2f mean_lag_px=%.2f p95_lag_px=%.2f wall_seconds=%.2f initial=%.0fx%.0f final=%.0fx%.0f",
            pid,
            options.tabIdentifier ?? "unchanged",
            options.duration,
            state.snapshot().sentEvents,
            observedChanges,
            uniqueSizes.count,
            geometryRate,
            percentile(intervals, 0.50),
            percentile(intervals, 0.95),
            intervals.max() ?? 0,
            meanLag,
            percentile(lagSamples, 0.95),
            elapsed,
            initialSize.width,
            initialSize.height,
            finalSize.width,
            finalSize.height
        )
    )
    if let trackedIdentifier = options.trackedIdentifier {
        print(
            String(
                format: "chrome_track id=%@ samples=%d max_position_drift_px=%.2f max_size_drift_px=%.2f",
                trackedIdentifier,
                trackedPositionDrift.count,
                trackedPositionDrift.max() ?? 0,
                trackedSizeDrift.max() ?? 0
            )
        )
    }
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(1)
}
