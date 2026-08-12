#!/usr/bin/env swift

import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 2,
      let processIdentifier = pid_t(CommandLine.arguments[1]) else {
    fputs("usage: macos-window-drag.swift <pid> [seconds]\n", stderr)
    exit(64)
}

let duration = CommandLine.arguments.count >= 3
    ? max(1, Double(CommandLine.arguments[2]) ?? 6)
    : 6
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
guard let window = windows.first(where: { entry in
    guard let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
          ownerPID == Int(processIdentifier),
          let boundsDictionary = entry[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary) else {
        return false
    }
    return bounds.width >= 300 && bounds.height >= 120
}), let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
   let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary) else {
    fputs("no visible main window found for pid \(processIdentifier)\n", stderr)
    exit(1)
}

let framesPerSecond = 60.0
let frameCount = max(1, Int(duration * framesPerSecond))
let start = CGPoint(x: bounds.midX, y: bounds.minY + 9)
let amplitude = min(180, max(80, bounds.minX - 40))

func post(_ type: CGEventType, at point: CGPoint) {
    guard let event = CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else {
        return
    }
    event.post(tap: .cghidEventTap)
}

post(.mouseMoved, at: start)
usleep(100_000)
post(.leftMouseDown, at: start)
let startedAt = ContinuousClock.now
for frame in 1...frameCount {
    let progress = Double(frame) / Double(frameCount)
    let x = start.x + CGFloat(sin(progress * .pi * 4)) * amplitude
    post(.leftMouseDragged, at: CGPoint(x: x, y: start.y))
    let target = startedAt + .seconds(Double(frame) / framesPerSecond)
    let remaining = ContinuousClock.now.duration(to: target)
    if remaining > .zero {
        Thread.sleep(forTimeInterval: Double(remaining.components.attoseconds) / 1e18
            + Double(remaining.components.seconds))
    }
}
post(.leftMouseUp, at: start)
print("dragged pid=\(processIdentifier) seconds=\(duration) frames=\(frameCount)")
