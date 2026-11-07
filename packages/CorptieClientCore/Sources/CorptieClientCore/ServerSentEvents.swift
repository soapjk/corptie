import Foundation

public struct ServerSentEvent: Equatable, Sendable {
    public let id: String?
    public let name: String
    public let data: String
    public let isComment: Bool

    public init(id: String?, name: String, data: String, isComment: Bool = false) {
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
public struct ServerSentEventParser: Sendable {
    public init() {}
    private var frameBytes = Data()

    public mutating func append(_ byte: UInt8) -> [ServerSentEvent] {
        frameBytes.append(byte)
        guard frameEnded else { return [] }
        let event = decodeFrame(frameBytes)
        frameBytes.removeAll(keepingCapacity: true)
        return event.map { [$0] } ?? []
    }

    public mutating func finish() -> [ServerSentEvent] {
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

/// Pull-driven parsing: one next() consumes only enough bytes for one event.
/// No producer task or application-level event queue sits ahead of the consumer.
public struct ServerSentEventSequence<Bytes: AsyncSequence & Sendable>: AsyncSequence where Bytes.Element == UInt8 {
    public typealias Element = ServerSentEvent
    let bytes: Bytes
    public struct AsyncIterator: AsyncIteratorProtocol {
        private var source: Bytes.AsyncIterator
        private var parser = ServerSentEventParser()
        private var ended = false
        fileprivate init(source: Bytes.AsyncIterator) { self.source = source }

        // Explicitly leave a caller's actor while parsing; never dispatch per byte.
        @concurrent public mutating func next() async throws -> ServerSentEvent? {
            guard !ended else { try Task.checkCancellation(); return nil }
            // next() must reach the upstream iterator even when cancelled, so
            // AsyncThrowingStream relays can run their termination handlers.
            while let byte = try await source.next() {
                try Task.checkCancellation()
                if let event = parser.append(byte).first { return event }
            }
            ended = true
            try Task.checkCancellation()
            return parser.finish().first
        }
    }
    public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(source: bytes.makeAsyncIterator()) }
}

public enum ServerSentEventStream {
    public static func events<Bytes: AsyncSequence & Sendable>(
        from bytes: Bytes
    ) -> ServerSentEventSequence<Bytes> where Bytes.Element == UInt8 {
        ServerSentEventSequence(bytes: bytes)
    }
}
