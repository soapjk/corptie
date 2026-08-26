import Foundation

struct ServerSentEvent: Equatable, Sendable {
    let id: String?
    let name: String
    let data: String
    let isComment: Bool

    init(id: String?, name: String, data: String, isComment: Bool = false) {
        self.id = id
        self.name = name
        self.data = data
        self.isComment = isComment
    }
}

/// Incrementally decodes the wire format instead of relying on
/// `URLSession.AsyncBytes.lines`. Foundation's line sequence omits the blank
/// lines that delimit SSE frames on macOS, so a line-based decoder can keep a
/// healthy connection while never dispatching an event.
struct ServerSentEventParser: Sendable {
    private var frameBytes = Data()

    mutating func append(_ byte: UInt8) -> [ServerSentEvent] {
        frameBytes.append(byte)
        guard frameEnded else { return [] }
        let event = decodeFrame(frameBytes)
        frameBytes.removeAll(keepingCapacity: true)
        return event.map { [$0] } ?? []
    }

    mutating func finish() -> [ServerSentEvent] {
        guard !frameBytes.isEmpty else { return [] }
        let event = decodeFrame(frameBytes)
        frameBytes.removeAll(keepingCapacity: true)
        return event.map { [$0] } ?? []
    }

    private var frameEnded: Bool {
        if frameBytes.count >= 2,
           frameBytes[frameBytes.count - 2] == 0x0A,
           frameBytes[frameBytes.count - 1] == 0x0A {
            return true
        }
        return frameBytes.count >= 4
            && frameBytes[frameBytes.count - 4] == 0x0D
            && frameBytes[frameBytes.count - 3] == 0x0A
            && frameBytes[frameBytes.count - 2] == 0x0D
            && frameBytes[frameBytes.count - 1] == 0x0A
    }

    private func decodeFrame(_ bytes: Data) -> ServerSentEvent? {
        guard let raw = String(data: bytes, encoding: .utf8) else { return nil }
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
        var eventID: String?
        var eventName = "message"
        var dataLines: [String] = []
        var containsComment = false

        for line in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
            guard !line.isEmpty else { continue }
            if line.hasPrefix(":") {
                containsComment = true
                continue
            }
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            let field = String(parts[0])
            var value = parts.count > 1 ? String(parts[1]) : ""
            if value.hasPrefix(" ") { value.removeFirst() }
            switch field {
            case "id":
                if !value.contains("\0") { eventID = value }
            case "event":
                if !value.isEmpty { eventName = value }
            case "data":
                dataLines.append(value)
            default:
                break
            }
        }

        if dataLines.isEmpty {
            return containsComment
                ? ServerSentEvent(id: nil, name: "", data: "", isComment: true)
                : nil
        }
        return ServerSentEvent(id: eventID, name: eventName, data: dataLines.joined(separator: "\n"))
    }
}

enum ServerSentEventStream {
    static func events(
        from bytes: URLSession.AsyncBytes
    ) -> AsyncThrowingStream<ServerSentEvent, Error> {
        AsyncThrowingStream { continuation in
            let decodingTask = Task.detached(priority: .userInitiated) {
                do {
                    var parser = ServerSentEventParser()
                    for try await byte in bytes {
                        if Task.isCancelled { return }
                        for event in parser.append(byte) {
                            continuation.yield(event)
                        }
                    }
                    for event in parser.finish() {
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in decodingTask.cancel() }
        }
    }
}
