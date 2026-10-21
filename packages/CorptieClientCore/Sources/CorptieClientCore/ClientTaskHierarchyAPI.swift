import Foundation

public struct ClientTaskHierarchyAPI: Sendable {
    public enum Surface: Sendable { case local, pairedDevice }
    private let transport: BackendTransport
    private let surface: Surface

    public init(transport: BackendTransport, surface: Surface) {
        self.transport = transport; self.surface = surface
    }

    public func page(workID: String, parentTaskID: String? = nil, cursor: String? = nil,
                     query: String? = nil, includeCompleted: Bool = true,
                     includeArchived: Bool = false) async throws -> ClientTaskHierarchyPage {
        var parameters = [URLQueryItem(name: "parentTaskId", value: parentTaskID ?? "root"),
                          URLQueryItem(name: "limit", value: "50"),
                          URLQueryItem(name: "includeCompleted", value: String(includeCompleted)),
                          URLQueryItem(name: "includeArchived", value: String(includeArchived))]
        if let cursor { parameters.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let query { parameters.append(URLQueryItem(name: "q", value: query)) }
        let prefix = surface == .pairedDevice ? ["client", "v1"] : []
        let request = try transport.endpoint.request(path: prefix + ["works", workID, "task-hierarchy"], query: parameters)
        let (data, _) = try await transport.data(for: request)
        let page = try JSONDecoder().decode(ClientTaskHierarchyPage.self, from: data)
        guard page.schemaVersion == 1, page.scope.workId == workID,
              ["roots", "children", "search"].contains(page.scope.mode),
              page.scope.parentTaskId == parentTaskID else { throw ClientConnectionError.invalidResponse }
        return page
    }
}
