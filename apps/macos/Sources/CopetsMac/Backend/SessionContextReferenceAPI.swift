import Foundation
import CorptieClientCore

/// Request contracts only; selection, loading flags and reference state stay with the caller.
@MainActor
protocol SessionContextReferenceServing {
    func list(sessionID: String) async throws -> [SessionContextReference]
    func add(sessionID: String, type: SessionContextReferenceType, targetID: String?, locator: String?, displayName: String?) async throws
    func refresh(sessionID: String, referenceID: String) async throws
    func delete(sessionID: String, referenceID: String) async throws
    func update(sessionID: String, referenceID: String, body: [String: Any]) async throws
}

@MainActor
struct SessionContextReferenceAPI: SessionContextReferenceServing {
    let baseURL: URL
    let urlSession: URLSession
    let validateResponse: (URLResponse, Data) throws -> Void

    func list(sessionID: String) async throws -> [SessionContextReference] {
        let (data, response) = try await urlSession.data(from: collectionURL(sessionID))
        try validateResponse(response, data)
        return try JSONDecoder().decode(SessionContextReferenceListEnvelope.self, from: data).references
    }

    func add(sessionID: String, type: SessionContextReferenceType, targetID: String?, locator: String?, displayName: String?) async throws {
        var body: [String: Any] = ["targetType": type.rawValue]
        if let targetID { body["targetId"] = targetID }
        if let locator { body["locator"] = locator }
        if let displayName, !displayName.isEmpty { body["displayName"] = displayName }
        try await send(method: "POST", url: collectionURL(sessionID), body: body)
    }

    func refresh(sessionID: String, referenceID: String) async throws {
        try await send(method: "POST", url: collectionURL(sessionID).appending(path: "\(referenceID)/refresh"))
    }

    func delete(sessionID: String, referenceID: String) async throws {
        try await send(method: "DELETE", url: collectionURL(sessionID).appending(path: referenceID))
    }

    func update(sessionID: String, referenceID: String, body: [String: Any]) async throws {
        try await send(method: "PATCH", url: collectionURL(sessionID).appending(path: referenceID), body: body)
    }

    private func collectionURL(_ sessionID: String) -> URL {
        baseURL.appending(path: "sessions/\(sessionID)/context-references")
    }

    private func send(method: String, url: URL, body: [String: Any]? = nil) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await urlSession.data(for: request)
        try validateResponse(response, data)
    }
}
