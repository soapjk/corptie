import Foundation
import CorptieClientCore

@MainActor
protocol ScheduledTaskServing {
    func list(logicalSessionId: String?) async throws -> [ScheduledSessionTask]
    func mutate(method: String, path: String, body: [String: Any]?) async throws
}

@MainActor
struct ScheduledTaskAPI: ScheduledTaskServing {
    let baseURL: URL
    let urlSession: URLSession

    nonisolated static func listURL(baseURL: URL, logicalSessionId: String? = nil) -> URL? {
        var components = URLComponents(url: baseURL.appending(path: ScheduledSessionAPIContract.collectionPath), resolvingAgainstBaseURL: false)
        var queryItems = [URLQueryItem(name: "includeRuns", value: "true")]
        if let logicalSessionId { queryItems.append(URLQueryItem(name: "logicalSessionId", value: logicalSessionId)) }
        components?.queryItems = queryItems
        return components?.url
    }

    func list(logicalSessionId: String? = nil) async throws -> [ScheduledSessionTask] {
        guard let url = Self.listURL(baseURL: baseURL, logicalSessionId: logicalSessionId) else { throw URLError(.badURL) }
        let metric = logicalSessionId == nil ? "计划任务总览" : "计划任务"
        let (data, response) = try await PerfStopwatch.measure("\(metric).前端HTTP") {
            try await urlSession.data(from: url)
        }
        try Self.requireSuccess(response, data: data)
        return try PerfStopwatch.measure("\(metric).前端解码") {
            if logicalSessionId != nil,
               let envelope = try? JSONDecoder().decode(ScheduledSessionTaskListEnvelope.self, from: data) {
                return envelope.tasks
            }
            if logicalSessionId != nil {
                return try JSONDecoder().decode([ScheduledSessionTask].self, from: data)
            }
            return try JSONDecoder().decode(ScheduledSessionTaskListEnvelope.self, from: data).tasks
        }
    }

    func mutate(method: String, path: String, body: [String: Any]? = nil) async throws {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await urlSession.data(for: request)
        try Self.requireSuccess(response, data: data)
    }

    private nonisolated static func requireSuccess(_ response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let code = object["code"] as? String
                let message = object["error"] as? String
                if code != nil || message != nil {
                    throw BackendError.message([code, message].compactMap { $0 }.joined(separator: " · "))
                }
            }
            throw BackendError.message("Scheduled Session task request failed.")
        }
    }
}
