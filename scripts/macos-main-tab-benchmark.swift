#!/usr/bin/env swift

import ApplicationServices
import Foundation

private let tabIdentifiers = [
    "main-tab.console",
    "main-tab.sessions",
    "main-tab.automations",
    "main-tab.worktrees",
    "main-tab.sessionDSH",
    "main-tab.agents",
]

private func attribute(_ name: CFString, of element: AXUIElement) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

private func element(
    withIdentifier wantedIdentifier: String,
    below root: AXUIElement
) -> AXUIElement? {
    var queue = [root]
    var visited = 0
    while !queue.isEmpty, visited < 10_000 {
        let candidate = queue.removeFirst()
        visited += 1
        if attribute(kAXIdentifierAttribute as CFString, of: candidate) as? String == wantedIdentifier {
            return candidate
        }
        if let children = attribute(kAXChildrenAttribute as CFString, of: candidate) as? [AXUIElement] {
            queue.append(contentsOf: children)
        }
    }
    return nil
}

private func percentile(_ values: [Double], fraction: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let index = min(sorted.count - 1, Int((Double(sorted.count - 1) * fraction).rounded(.up)))
    return sorted[index]
}

guard CommandLine.arguments.count >= 2,
      let processIdentifier = pid_t(CommandLine.arguments[1]) else {
    fputs("usage: macos-main-tab-benchmark.swift <app-pid> [cycles] [interval-ms]\n", stderr)
    exit(2)
}

let cycles = CommandLine.arguments.count > 2 ? max(1, Int(CommandLine.arguments[2]) ?? 12) : 12
let intervalMilliseconds = CommandLine.arguments.count > 3
    ? max(0, Int(CommandLine.arguments[3]) ?? 35)
    : 35
let application = AXUIElementCreateApplication(processIdentifier)

guard AXIsProcessTrusted() else {
    fputs("Accessibility permission is required for the invoking terminal.\n", stderr)
    exit(3)
}

for identifier in tabIdentifiers {
    guard element(withIdentifier: identifier, below: application) != nil else {
        fputs("Could not find accessibility element \(identifier).\n", stderr)
        exit(4)
    }
}

// Materialize and retain all six heavyweight page hosts before measuring the
// cached switching path. Accessibility elements are resolved for every press
// because SwiftUI legitimately rebuilds a button's AX node when selection flips.
for identifier in tabIdentifiers {
    guard let button = element(withIdentifier: identifier, below: application),
          AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
        fputs("Warm-up AX press failed for \(identifier).\n", stderr)
        exit(5)
    }
    Thread.sleep(forTimeInterval: 0.26)
}
Thread.sleep(forTimeInterval: MainTabTiming.settleDelay)

var buttons: [String: AXUIElement] = [:]
for identifier in tabIdentifiers {
    guard let button = element(withIdentifier: identifier, below: application) else {
        fputs("Could not refresh warmed accessibility element \(identifier).\n", stderr)
        exit(4)
    }
    buttons[identifier] = button
}

var pressLatencies: [Double] = []
var refreshedElementCount = 0
let startedAt = CFAbsoluteTimeGetCurrent()
for index in 0..<(cycles * tabIdentifiers.count) {
    let identifier = tabIdentifiers[index % tabIdentifiers.count]
    guard var button = buttons[identifier] else { continue }
    var pressStartedAt = CFAbsoluteTimeGetCurrent()
    var result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    if result != .success {
        guard let refreshed = element(withIdentifier: identifier, below: application) else {
            fputs("Could not refresh accessibility element \(identifier).\n", stderr)
            exit(4)
        }
        refreshedElementCount += 1
        button = refreshed
        buttons[identifier] = refreshed
        pressStartedAt = CFAbsoluteTimeGetCurrent()
        result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    }
    guard result == .success else {
        fputs("AX press failed for \(identifier).\n", stderr)
        exit(5)
    }
    pressLatencies.append((CFAbsoluteTimeGetCurrent() - pressStartedAt) * 1_000)
    if intervalMilliseconds > 0 {
        Thread.sleep(forTimeInterval: Double(intervalMilliseconds) / 1_000)
    }
}

// Allow the current pair and the coalesced final destination to complete.
Thread.sleep(forTimeInterval: MainTabTiming.settleDelay)

let finalIdentifier = tabIdentifiers[(cycles * tabIdentifiers.count - 1) % tabIdentifiers.count]
let finalValue = element(withIdentifier: finalIdentifier, below: application).flatMap {
    attribute(kAXValueAttribute as CFString, of: $0) as? String
}
let elapsed = CFAbsoluteTimeGetCurrent() - startedAt
let average = pressLatencies.reduce(0, +) / Double(max(1, pressLatencies.count))
let p95 = percentile(pressLatencies, fraction: 0.95)
let maximum = pressLatencies.max() ?? 0
let elapsedText = String(format: "%.3f", elapsed)
let averageText = String(format: "%.3f", average)
let p95Text = String(format: "%.3f", p95)
let maximumText = String(format: "%.3f", maximum)
let finalValueText = finalValue ?? "missing"
let processIsAlive = kill(processIdentifier, 0) == 0

print("[MainTabBenchmark] warmup_presses=6 measured_presses=\(pressLatencies.count) refreshed_ax_elements=\(refreshedElementCount) interval_ms=\(intervalMilliseconds) elapsed_s=\(elapsedText)")
print("[MainTabBenchmark] press_latency_ms average=\(averageText) p95=\(p95Text) max=\(maximumText)")
print("[MainTabBenchmark] final=\(finalIdentifier) value=\(finalValueText) process_alive=\(processIsAlive)")

guard finalValue == "selected", processIsAlive else { exit(6) }
guard p95 < 120, maximum < 250 else { exit(7) }

private enum MainTabTiming {
    // Two 220 ms animations cover an in-flight pair plus the latest coalesced request.
    static let settleDelay: TimeInterval = 0.55
}
