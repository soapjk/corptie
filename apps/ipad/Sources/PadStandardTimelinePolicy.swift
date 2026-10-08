import Foundation

/// Local-only numeric/boolean snapshots. No message, session or account data.
struct PadTimelineDiagnosticRecord: Codable, Sendable {
    var timestamp = Date().timeIntervalSince1970
    var uptime = ProcessInfo.processInfo.systemUptime
    let event: String
    let page: UUID
    let flags: [String: Bool]
    let numbers: [String: Double]
}

/// A bounded non-blocking producer; all encoding and file IO stay off main.
final class PadTimelineDiagnosticLog: @unchecked Sendable {
    static let shared = PadTimelineDiagnosticLog(directory: FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TimelineDiagnostics"))
    private let directory: URL
    private let limit: Int
    private let queue = DispatchQueue(label: "corptie.timeline-diagnostics", qos: .utility)
    private let slots = DispatchSemaphore(value: 128)
    init(directory: URL, limit: Int = 1_048_576) {
        self.directory = directory; self.limit = limit
    }
    func append(_ record: PadTimelineDiagnosticRecord) {
        guard slots.wait(timeout: .now()) == .success else { return }
        queue.async { [self] in
            defer { slots.signal() }
            do {
                var data = try JSONEncoder().encode(record)
                data.append(10)
                guard data.count <= limit else { return }
                let fm = FileManager.default
                try fm.createDirectory(at: directory, withIntermediateDirectories: true)
                let current = directory.appendingPathComponent("current.jsonl")
                let previous = directory.appendingPathComponent("previous.jsonl")
                let size = (try? fm.attributesOfItem(atPath: current.path)[.size] as? NSNumber)?.intValue ?? 0
                if size + data.count > limit {
                    if fm.fileExists(atPath: previous.path) { try fm.removeItem(at: previous) }
                    try fm.moveItem(at: current, to: previous)
                }
                if !fm.fileExists(atPath: current.path) { fm.createFile(atPath: current.path, contents: nil) }
                let handle = try FileHandle(forWritingTo: current)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } catch {
                // Diagnostics must never interrupt delivery or scrolling.
                NSLog("Timeline diagnostic write failed (%@)", String(describing: type(of: error)))
            }
        }
    }
    /// Only used by host tests, never by the UI.
    func drainForTesting() { queue.sync {} }
}

/// User intent only. The system owns sizing, scrolling and keyboard physics.
struct PadStandardTimelinePolicy: Equatable {
    private(set) var followsLatest = true
    private(set) var interacting = false
    private(set) var unreadBelow = false
    private(set) var restoring = false
    private(set) var atBottom = true
    mutating func begin(saved: PadTimelineReadingPosition?) {
        followsLatest = saved?.followsLatest ?? true
        restoring = saved?.followsLatest == false
    }
    mutating func beginInteraction(bottom: Bool? = nil) {
        if let bottom { atBottom = bottom }
        // Touching/overscrolling the bottom is not leaving it. Geometry may
        // remain unchanged throughout that gesture, so no callback repairs a
        // flag unconditionally cleared here.
        followsLatest = !restoring && atBottom
        interacting = true; restoring = false
    }
    mutating func endInteraction(bottom: Bool? = nil, keyboardChanging: Bool = false) {
        guard interacting else { return }
        if let bottom { atBottom = bottom }
        interacting = false
        if atBottom || !keyboardChanging { followsLatest = atBottom }
    }
    mutating func observeBottom(_ bottom: Bool, keyboardChanging: Bool) {
        atBottom = bottom
        // The final geometry may arrive after the idle phase. Reaching bottom
        // must resume following in either order. Passive growth away from bottom
        // must not cancel an existing follow intent.
        if !restoring {
            if bottom && (interacting || !keyboardChanging) {
                followsLatest = true
            } else if interacting && !keyboardChanging {
                followsLatest = false
            }
        }
        if bottom { unreadBelow = false }
    }
    mutating func contentChanged() { if !followsLatest { unreadBelow = true } }
    mutating func jump() { restoring = false; interacting = false; followsLatest = true; unreadBelow = false }
    mutating func restored() { restoring = false; followsLatest = false }
    func showsJump(hasMessages: Bool, keyboardVisible: Bool, keyboardChanging: Bool) -> Bool {
        hasMessages && !restoring && !atBottom && !keyboardVisible && !keyboardChanging
    }
    static func bottomReached(visibleBottom: CGFloat, contentHeight: CGFloat) -> Bool {
        guard visibleBottom.isFinite, contentHeight.isFinite else { return false }
        return visibleBottom >= contentHeight - 1
    }
    static func restorationAnchor(minY: CGFloat, viewportHeight: CGFloat, rowHeight: CGFloat) -> CGFloat? {
        let denominator = viewportHeight - rowHeight
        guard abs(denominator) > 1 else { return nil }
        return minY / denominator
    }
}
