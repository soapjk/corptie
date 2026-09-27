import Foundation

/// Bounded structured supplementary data; never interpreted as executable UI or code.
public enum ClientInspectorValue: Codable, Equatable, Sendable {
    case object([String: Self]), array([Self]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([Self].self) { self = .array(v) }
        else { self = .object(try c.decode([String: Self].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> Self { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var text: String? { if case .string(let v) = self { return v }; return nil }
    public var items: [Self] { if case .array(let v) = self { return v }; return [] }
    public var flag: Bool { if case .bool(let v) = self { return v }; return false }
    public var number: Double? { if case .number(let v) = self { return v }; return nil }
    public var fields: [String: Self] { if case .object(let v) = self { return v }; return [:] }
    public var formatted: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

public struct ClientInspectorSnapshot: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let sessionId: String
    public let resolvedSessionId: String
    public let workId: String?
    public let taskId: String?
    public let taskDefinition: ClientInspectorValue?
    public let workDescription: String?
    public let summary: String?
    public let environment: ClientInspectorValue
    public let sections: [String: ClientInspectorValue]
    public let errors: [String: String]
}

public struct ClientInspectorAPI: Sendable {
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }
    private func path(_ sessionID: String, _ suffix: String) -> [String] {
        ["client", "v1", "sessions", sessionID, "inspector", suffix]
    }
    public func subscribe(sessionID: String) -> AsyncThrowingStream<ClientInspectorSnapshot, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    var request = try transport.endpoint.request(path: path(sessionID, "events"))
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = 35
                    let (bytes, response) = try await transport.bytes(for: request)
                    guard response.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else {
                        throw ClientConnectionError.invalidResponse
                    }
                    var parser = ServerSentEventParser(); var count = 0
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        count += 1
                        guard count <= 2 * 1024 * 1024 else { throw ClientConnectionError.invalidResponse }
                        for event in parser.append(byte) {
                            count = 0
                            if event.isComment || event.name == "heartbeat" { continue }
                            if event.name == "inspector-error" {
                                let error = try JSONDecoder().decode([String: String].self, from: Data(event.data.utf8))
                                throw ClientServiceFailure(statusCode: Int(error["status"] ?? "503") ?? 503, code: error["code"] ?? "INSPECTOR_READ_FAILED")
                            }
                            guard event.name == "inspector-snapshot" else { throw ClientConnectionError.invalidResponse }
                            let snapshot = try JSONDecoder().decode(ClientInspectorSnapshot.self, from: Data(event.data.utf8))
                            guard snapshot.schemaVersion == 1, snapshot.sessionId == sessionID else { throw ClientConnectionError.invalidResponse }
                            continuation.yield(snapshot)
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }
    public func read(sessionID: String, resource: String, parameters: [String: ClientInspectorValue] = [:]) async throws -> ClientInspectorValue {
        try await post(path(sessionID, "read"), ["resource": .string(resource), "parameters": .object(parameters)])
    }
    public func command(sessionID: String, requestID: String, action: String, fields: [String: ClientInspectorValue]) async throws -> ClientCommandReceipt {
        try await post(path(sessionID, "commands"), ["requestId": .string(requestID), "action": .string(action), "fields": .object(fields)])
    }
    private func post<T: Decodable>(_ path: [String], _ body: [String: ClientInspectorValue]) async throws -> T {
        var request = try transport.endpoint.request(path: path)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
