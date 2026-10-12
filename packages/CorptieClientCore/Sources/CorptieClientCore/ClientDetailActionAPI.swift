import Foundation

public protocol ClientDetailActionTransport: Sendable {
    func read(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientInspectorValue
    func command(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientCommandReceipt
    func receipt(sessionID: String, requestID: String) async throws -> ClientCommandReceipt
}

public struct ClientDetailActionAPI: ClientDetailActionTransport {
    private let transport: BackendTransport
    private let route: ClientDetailAPI.Route
    public init(transport: BackendTransport, route: ClientDetailAPI.Route) { self.transport = transport; self.route = route }
    private func fetch<T: Decodable>(sessionID: String, suffix: [String], body: ClientDetailActionRequest? = nil) async throws -> T {
        let prefix = route == .desktop ? [] : ["client", "v1"]
        var request = try transport.endpoint.request(path: prefix + ["sessions", sessionID, "detail"] + suffix)
        request.setValue("application/json; corptie-detail=native-v1", forHTTPHeaderField: "Accept")
        if let body {
            try body.validate()
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, _) = try await transport.data(for: request)
        guard data.count <= ClientDetailProtocol.maxDocumentBytes else { throw ClientDetailFailure.limit }
        return try JSONDecoder().decode(T.self, from: data)
    }
    public func read(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientInspectorValue {
        try await fetch(sessionID: sessionID, suffix: ["read"], body: request)
    }
    public func command(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientCommandReceipt {
        try await fetch(sessionID: sessionID, suffix: ["actions"], body: request)
    }
    public func receipt(sessionID: String, requestID: String) async throws -> ClientCommandReceipt {
        try await fetch(sessionID: sessionID, suffix: ["receipts", requestID])
    }
}

/// This is a registry of native destinations, not a URL interpreter.
public enum ClientDetailActionRouting {
    /// The platform registers only destinations it can actually present.
    /// Wire tokens alone never imply that a native editor exists on a client.
    public struct Resolver: Sendable {
        private let registrations: [String: Set<String>]
        public init(registrations: [String: Set<String>] = [:]) { self.registrations = registrations }
        public func target(for action: ClientDetailAction) throws -> ClientDetailAction.Target {
            let target = try ClientDetailActionRouting.target(for: action)
            guard registrations[action.operation]?.contains(target.resourceType) == true else {
                throw ClientServiceFailure(statusCode: 409, code: "DETAIL_NAVIGATION_UNAVAILABLE")
            }
            return target
        }
    }
    public static let destinations: [String: Set<String>] = [
        "resource.open": ["session", "task", "work", "schedule", "artifact", "memory", "reference"],
        "editor.open": ["task", "schedule", "provider", "worktree", "artifact", "memory", "reference"]
    ]
    public static func target(for action: ClientDetailAction) throws -> ClientDetailAction.Target {
        guard action.kind == "navigation", action.available, let target = action.target,
              !target.id.isEmpty, destinations[action.operation]?.contains(target.resourceType) == true else {
            throw ClientServiceFailure(statusCode: 409, code: "DETAIL_NAVIGATION_UNSUPPORTED")
        }
        return target
    }
}
