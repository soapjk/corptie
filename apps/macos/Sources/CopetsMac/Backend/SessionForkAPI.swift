import Foundation

@MainActor
struct SessionForkAPI {
    let baseURL: URL
    let urlSession: URLSession

    func previewSessionFork(_ selection: SessionForkSelection) async throws -> SessionForkPreview {
        var url = URLComponents(url: baseURL.appending(path: "sessions/\(selection.sessionID)/fork"), resolvingAgainstBaseURL: false)!
        url.queryItems = [.init(name: "itemId", value: selection.itemID)]
        let (data, response) = try await urlSession.data(from: url.url!)
        try validateForkResponse(data, response)
        return try JSONDecoder().decode(SessionForkPreview.self, from: data)
    }

    func createSessionFork(_ selection: SessionForkSelection, requestID: String, sourceBindingID: String,
                           title: String, description: String, acceptanceCriteria: String) async throws -> SessionForkResponse {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(selection.sessionID)/fork"))
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "requestId": requestID, "itemId": selection.itemID, "sourceBindingId": sourceBindingID,
            "title": title, "description": description, "acceptanceCriteria": acceptanceCriteria
        ])
        let (data, response) = try await urlSession.data(for: request)
        try validateForkResponse(data, response)
        return try JSONDecoder().decode(SessionForkResponse.self, from: data)
    }

    private func validateForkResponse(_ data: Data, _ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw BackendError.message(body?["error"] as? String ?? "分支创建失败，请稍后重试。")
        }
    }
}
