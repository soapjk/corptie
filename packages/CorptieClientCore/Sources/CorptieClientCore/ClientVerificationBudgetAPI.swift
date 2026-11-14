import Foundation

public struct VerificationBudget: Decodable, Identifiable, Sendable {
    public var id: String { instructionId }
    public let instructionId: String
    public let instruction: String?
    public let limit: Int
    public let used: Int
    public let paused: Bool
    public let stopped: Bool
    public let running: Bool
    public let limitation: String
    public let runs: [Run]
    public struct Run: Decodable, Identifiable, Sendable {
        public var id: String { execution_id }
        public let execution_id: String
        public let status: String
    }
}

public struct ClientVerificationBudgetAPI: Sendable {
    private let transport: BackendTransport
    private let paired: Bool
    public init(transport: BackendTransport, paired: Bool = false) { self.transport = transport; self.paired = paired }
    private func request<T: Decodable>(path: [String], body: Data? = nil) async throws -> T {
        var request = try transport.endpoint.request(path: (paired ? ["client", "v1"] : []) + path)
        if let body {
            request.httpMethod = "POST"; request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }
    public func read(taskID: String) async throws -> [VerificationBudget] {
        struct Response: Decodable { let budgets: [VerificationBudget] }
        let response: Response = try await request(path: ["tasks", taskID, "verification-budgets"])
        return response.budgets
    }
    public func update(taskID: String, instructionID: String, stop: Bool, requestID: String) async throws {
        struct Body: Encodable { let requestId: String; let amount = 1 }
        struct Response: Decodable { let budget: VerificationBudget }
        let _: Response = try await request(path: ["tasks", taskID, "verification-budgets", instructionID, stop ? "stop" : "extend"],
            body: JSONEncoder().encode(Body(requestId: requestID)))
    }
    public func defaultLimit(_ value: Int? = nil) async throws -> Int {
        struct Response: Decodable { let limit: Int }
        struct Body: Encodable { let limit: Int }
        let body = try value.map { try JSONEncoder().encode(Body(limit: $0)) }
        let response: Response = try await request(path: ["settings", "verification-budget"], body: body)
        return response.limit
    }
}
