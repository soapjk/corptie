import Foundation

public struct ExecutionChecklistCommand: Encodable, Sendable {
    public var action: String
    public var expectedRevision: Int
    public var operationId: String
    public var itemId: String?
    public var text: String?
    public var condition: String?
    public var status: String?
    public var reason: String?
    public var position: Int?
    public var itemIds: [String]?
    public var taskId: String?
    public var dispatchId: String?
    public var planId: String? = nil
    public init(action: String, revision: Int, itemID: String? = nil, text: String? = nil,
                condition: String? = nil, status: String? = nil, reason: String? = nil, position: Int? = nil, itemIDs: [String]? = nil, taskID: String? = nil, dispatchID: String? = nil) {
        self.action = action; expectedRevision = revision; operationId = UUID().uuidString
        itemId = itemID; self.text = text; self.condition = condition; self.status = status
        self.reason = reason; self.position = position
        self.itemIds = itemIDs; self.taskId = taskID; self.dispatchId = dispatchID
    }
}

public struct ClientExecutionChecklistAPI: Sendable {
    public struct Response: Decodable, Sendable {
        public let checklist: ConversationExecutionPlan?
        public let writesAllowed: Bool?
    }
    private let transport: BackendTransport
    private let route: ClientDetailAPI.Route
    public init(transport: BackendTransport, route: ClientDetailAPI.Route = .desktop) { self.transport = transport; self.route = route }
    private var prefix: [String] { route == .desktop ? [] : ["client", "v1"] }
    public func read(taskID: String, planID: String? = nil) async throws -> Response {
        let request = try transport.endpoint.request(path: prefix + ["tasks", taskID, "execution-checklist"], query: planID.map { [URLQueryItem(name: "planId", value: $0)] } ?? [])
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(Response.self, from: data)
    }
    public func update(taskID: String, command: ExecutionChecklistCommand) async throws -> Response {
        var request = try transport.endpoint.request(path: prefix + ["tasks", taskID, "execution-checklist"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(command)
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(Response.self, from: data)
    }
}
