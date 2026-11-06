import Foundation
import SwiftUI
import CorptieClientCore
import CorptieConversation

extension Notification.Name {
    static let sessionAbilitiesChanged = Notification.Name("Corptie.SessionAbilitiesChanged")
}

struct SessionAbilityPanel: View {
    let sessionID: String
    let logicalSessionID: String?
    @State private var refreshVersion = 0
    var body: some View {
        ConversationSessionAbilities(scope: sessionID, refreshKey: String(refreshVersion), read: {
            try await request(method: "GET")["preferences"]
        }, update: { fields, requestID in
            var input = fields; input["requestId"] = .string(requestID)
            _ = try await request(method: "PATCH", fields: input)
        }).id(sessionID)
        .onReceive(NotificationCenter.default.publisher(for: .sessionAbilitiesChanged)) { notification in
            guard let id = notification.object as? String, id == sessionID || id == logicalSessionID else { return }
            refreshVersion += 1
        }
    }
    private func request(method: String, fields: [String: ClientInspectorValue]? = nil) async throws -> ClientInspectorValue {
        let endpoint = try BackendEndpoint(CorptieAppEnvironment.backendBaseURL)
        var request = try endpoint.request(path: ["sessions", sessionID, "abilities"])
        request.httpMethod = method
        if let fields {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(fields)
        }
        let transport = try BackendTransport(endpoint: endpoint)
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(ClientInspectorValue.self, from: data)
    }
}
