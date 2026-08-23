#!/usr/bin/env swift

import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 2,
      let processIdentifier = pid_t(CommandLine.arguments[1]) else {
    fputs("usage: macos-window-resize-benchmark.swift <pid> [seconds] [slow|rapid|zoom]\n", stderr)
    exit(64)
}

let duration = CommandLine.arguments.count >= 3
    ? max(1, Double(CommandLine.arguments[2]) ?? 6)
    : 6
let mode = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : "rapid"

func visibleWindow() -> (number: CGWindowID, bounds: CGRect)? {
    let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    for entry in entries {
        guard let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
              ownerPID == Int(processIdentifier),
              let number = entry[kCGWindowNumber as String] as? CGWindowID,
              let dictionary = entry[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              bounds.width >= 300,
              bounds.height >= 120 else {
            continue
        }
        return (number, bounds)
    }
    return nil
}

func currentBounds(of number: CGWindowID) -> CGRect? {
    guard let entry = (CGWindowListCopyWindowInfo([.optionIncludingWindow], number)
        as? [[String: Any]])?.first,
          let dictionary = entry[kCGWindowBounds as String] as? [String: Any] else {
        return nil
    }
    return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
}

func percentile(_ values: [Double], _ percentile: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let index = min(sorted.count - 1, Int((Double(sorted.count - 1) * percentile).rounded()))
    return sorted[index]
}

func waitForStableBounds(number: CGWindowID, timeout: TimeInterval = 3) -> CGRect? {
    let deadline = Date().addingTimeInterval(timeout)
    var previous = currentBounds(of: number)
    var unchangedSamples = 0
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
        let current = currentBounds(of: number)
        if current == previous {
            unchangedSamples += 1
            if unchangedSamples >= 3 { return current }
        } else {
            unchangedSamples = 0
            previous = current
        }
    }
    return previous
}

guard let initial = visibleWindow() else {
    fputs("no visible main window found for pid \(processIdentifier)\n", stderr)
    exit(1)
}

guard let application = NSRunningApplication(processIdentifier: processIdentifier) else {
    fputs("could not resolve running application for pid \(processIdentifier)\n", stderr)
    exit(1)
}
application.activate()
let accessibilityApplication = AXUIElementCreateApplication(processIdentifier)
var accessibilityWindowsValue: CFTypeRef?
guard AXUIElementCopyAttributeValue(
    accessibilityApplication,
    kAXWindowsAttribute as CFString,
    &accessibilityWindowsValue
) == .success,
      let accessibilityWindows = accessibilityWindowsValue as? [AXUIElement],
      let accessibilityWindow = accessibilityWindows.first else {
    fputs("could not resolve accessibility window\n", stderr)
    exit(1)
}
_ = AXUIElementPerformAction(accessibilityWindow, kAXRaiseAction as CFString)
Thread.sleep(forTimeInterval: 0.2)

if mode == "zoom" {
    var zoomButtonValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        accessibilityWindow,
        kAXZoomButtonAttribute as CFString,
        &zoomButtonValue
    ) == .success,
          let zoomButton = zoomButtonValue else {
        fputs("could not resolve zoom button\n", stderr)
        exit(1)
    }

    let button = unsafeDowncast(zoomButton, to: AXUIElement.self)
    guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success,
          let maximized = waitForStableBounds(number: initial.number),
          AXUIElementPerformAction(button, kAXPressAction as CFString) == .success,
          let restored = waitForStableBounds(number: initial.number) else {
        fputs("zoom/restore action failed\n", stderr)
        exit(1)
    }

    let restoredExactly = abs(restored.width - initial.bounds.width) < 1
        && abs(restored.height - initial.bounds.height) < 1
    print(
        "mode=zoom initial=\(Int(initial.bounds.width))x\(Int(initial.bounds.height)) "
            + "maximized=\(Int(maximized.width))x\(Int(maximized.height)) "
            + "restored=\(Int(restored.width))x\(Int(restored.height)) "
            + "restored_exactly=\(restoredExactly)"
    )
    exit(restoredExactly ? 0 : 1)
}

func setWindowSize(_ size: CGSize) -> Bool {
    var size = size
    guard let value = AXValueCreate(.cgSize, &size) else { return false }
    return AXUIElementSetAttributeValue(
        accessibilityWindow,
        kAXSizeAttribute as CFString,
        value
    ) == .success
}

func processMetrics() -> (cpu: Double, rssKB: Int)? {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-p", String(processIdentifier), "-o", "%cpu=,rss="]
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    process.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let fields = String(decoding: data, as: UTF8.self)
        .split(whereSeparator: { $0.isWhitespace })
    guard fields.count >= 2,
          let cpu = Double(fields[0]),
          let rss = Int(fields[1]) else { return nil }
    return (cpu, rss)
}

let framesPerSecond = mode == "slow" ? 30.0 : 60.0
let cycles = mode == "slow" ? 0.5 : 4.0
let frameCount = max(1, Int(duration * framesPerSecond))
let horizontalAmplitude = min(220, max(100, initial.bounds.width - 980))
let verticalAmplitude = min(140, max(70, initial.bounds.height - 620))
var sizeErrors: [Double] = []
var updateIntervals: [Double] = []
var uniqueSizes = Set<String>()
var previousSize = initial.bounds.size
var lastUpdateTime = ContinuousClock.now
let baselineMetrics = processMetrics()
var cpuSamples: [Double] = []
var rssSamples: [Int] = []

let startedAt = ContinuousClock.now
for frame in 1...frameCount {
    let progress = Double(frame) / Double(frameCount)
    let wave = CGFloat(sin(progress * .pi * 2 * cycles))
    let expectedOffset = CGSize(
        width: wave * horizontalAmplitude,
        height: wave * verticalAmplitude
    )
    let expectedSize = CGSize(
        width: initial.bounds.width + expectedOffset.width,
        height: initial.bounds.height + expectedOffset.height
    )
    guard setWindowSize(expectedSize) else {
        fputs("accessibility resize failed at frame \(frame)\n", stderr)
        exit(1)
    }

    let target = startedAt + .seconds(Double(frame) / framesPerSecond)
    let remaining = ContinuousClock.now.duration(to: target)
    if remaining > .zero {
        Thread.sleep(forTimeInterval: Double(remaining.components.seconds)
            + Double(remaining.components.attoseconds) / 1e18)
    }

    guard let bounds = currentBounds(of: initial.number) else { continue }
    sizeErrors.append(hypot(
        Double(bounds.width - expectedSize.width),
        Double(bounds.height - expectedSize.height)
    ))
    uniqueSizes.insert("\(Int(bounds.width.rounded()))x\(Int(bounds.height.rounded()))")
    if bounds.size != previousSize {
        let now = ContinuousClock.now
        let interval = lastUpdateTime.duration(to: now)
        updateIntervals.append(
            Double(interval.components.seconds) * 1_000
                + Double(interval.components.attoseconds) / 1e15
        )
        previousSize = bounds.size
        lastUpdateTime = now
    }
    if frame.isMultiple(of: 10), let metrics = processMetrics() {
        cpuSamples.append(metrics.cpu)
        rssSamples.append(metrics.rssKB)
    }
}

let finalBounds = waitForStableBounds(number: initial.number) ?? initial.bounds
let meanError = sizeErrors.isEmpty ? 0 : sizeErrors.reduce(0, +) / Double(sizeErrors.count)
let observedFPS = Double(updateIntervals.count) / duration
let meanCPU = cpuSamples.isEmpty ? 0 : cpuSamples.reduce(0, +) / Double(cpuSamples.count)
let peakRSS = rssSamples.max() ?? baselineMetrics?.rssKB ?? 0
let rssDelta = peakRSS - (baselineMetrics?.rssKB ?? peakRSS)
print(
    String(
        format: "mode=%@ pid=%d events=%d observed=%d unique_sizes=%d observed_fps=%.1f mean_lag_px=%.2f p95_lag_px=%.2f p95_update_interval_ms=%.2f mean_cpu_pct=%.1f peak_rss_kb=%d rss_delta_kb=%d final=%dx%d",
        mode,
        processIdentifier,
        frameCount,
        sizeErrors.count,
        uniqueSizes.count,
        observedFPS,
        meanError,
        percentile(sizeErrors, 0.95),
        percentile(updateIntervals, 0.95),
        meanCPU,
        peakRSS,
        rssDelta,
        Int(finalBounds.width),
        Int(finalBounds.height)
    )
)

guard observedFPS >= (mode == "slow" ? 20 : 30),
      percentile(sizeErrors, 0.95) < (mode == "slow" ? 12 : 40),
      abs(finalBounds.width - initial.bounds.width) < 2,
      abs(finalBounds.height - initial.bounds.height) < 2 else {
    exit(1)
}
