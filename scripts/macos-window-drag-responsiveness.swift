#!/usr/bin/env swift

import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 2,
      let processIdentifier = pid_t(CommandLine.arguments[1]) else {
    fputs("usage: macos-window-drag-responsiveness.swift <pid> [seconds]\n", stderr)
    exit(64)
}

let duration = CommandLine.arguments.count >= 3
    ? max(1, Double(CommandLine.arguments[2]) ?? 6)
    : 6
let allWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
guard let entry = allWindows.first(where: { entry in
    guard let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
          ownerPID == Int(processIdentifier),
          let boundsDictionary = entry[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary) else {
        return false
    }
    return bounds.width >= 300 && bounds.height >= 120
}), let number = entry[kCGWindowNumber as String] as? CGWindowID,
   let initialBoundsDictionary = entry[kCGWindowBounds as String] as? [String: Any],
   let initialBounds = CGRect(dictionaryRepresentation: initialBoundsDictionary as CFDictionary) else {
    fputs("no visible main window found for pid \(processIdentifier)\n", stderr)
    exit(1)
}

func currentBounds() -> CGRect? {
    guard let entries = CGWindowListCopyWindowInfo([.optionIncludingWindow], number)
        as? [[String: Any]],
          let entry = entries.first,
          let dictionary = entry[kCGWindowBounds as String] as? [String: Any] else {
        return nil
    }
    return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
}

func post(_ type: CGEventType, at point: CGPoint) {
    CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: .left
    )?.post(tap: .cghidEventTap)
}

let framesPerSecond = 60.0
let frameCount = max(1, Int(duration * framesPerSecond))
let start = CGPoint(x: initialBounds.midX, y: initialBounds.minY + 9)
let amplitude = min(160, max(60, initialBounds.minX - 40))
var errors: [Double] = []
var updateIntervals: [Double] = []
var previousX = initialBounds.minX
var lastUpdateTime = ContinuousClock.now
var uniquePositions = Set<Int>()

post(.mouseMoved, at: start)
usleep(100_000)
post(.leftMouseDown, at: start)
let startedAt = ContinuousClock.now
for frame in 1...frameCount {
    let progress = Double(frame) / Double(frameCount)
    let expectedOffset = CGFloat(sin(progress * .pi * 4)) * amplitude
    post(.leftMouseDragged, at: CGPoint(x: start.x + expectedOffset, y: start.y))
    let target = startedAt + .seconds(Double(frame) / framesPerSecond)
    let remaining = ContinuousClock.now.duration(to: target)
    if remaining > .zero {
        Thread.sleep(forTimeInterval: Double(remaining.components.seconds)
            + Double(remaining.components.attoseconds) / 1e18)
    }
    guard let bounds = currentBounds() else { continue }
    let actualOffset = bounds.minX - initialBounds.minX
    errors.append(abs(Double(actualOffset - expectedOffset)))
    uniquePositions.insert(Int(bounds.minX.rounded()))
    if bounds.minX != previousX {
        let now = ContinuousClock.now
        let interval = lastUpdateTime.duration(to: now)
        updateIntervals.append(
            Double(interval.components.seconds) * 1_000
                + Double(interval.components.attoseconds) / 1e15
        )
        previousX = bounds.minX
        lastUpdateTime = now
    }
}
post(.leftMouseUp, at: start)

func percentile(_ values: [Double], _ percentile: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let index = min(sorted.count - 1, Int((Double(sorted.count - 1) * percentile).rounded()))
    return sorted[index]
}

let meanError = errors.isEmpty ? 0 : errors.reduce(0, +) / Double(errors.count)
print(
    String(
        format: "pid=%d frames=%d observed=%d unique_positions=%d mean_lag_px=%.2f p95_lag_px=%.2f p95_update_interval_ms=%.2f max_update_interval_ms=%.2f",
        processIdentifier,
        frameCount,
        errors.count,
        uniquePositions.count,
        meanError,
        percentile(errors, 0.95),
        percentile(updateIntervals, 0.95),
        updateIntervals.max() ?? 0
    )
)
