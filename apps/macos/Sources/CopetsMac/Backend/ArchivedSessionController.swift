import Foundation

/// Bounded archive inventory and deep-link lookup, separate from the active Session index.
@MainActor
final class ArchivedSessionController: ObservableObject {
    @Published private(set) var sessions: [TaskSession] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasMore = false
    @Published private(set) var loadError: String?
    var currentSessionKind: SessionKind? { sessionKind }
    private var nextCursor: String?
    private var sessionKind: SessionKind?

    private let baseURL: URL
    private let urlSession: URLSession
    private let selection: SessionSelectionController
    private let currentError: () -> String?
    private let reportError: (String?) -> Void

    private var archivedSessions: [TaskSession] {
        get { sessions }
        set { sessions = newValue }
    }
    private var isLoadingArchivedSessions: Bool {
        get { isLoading }
        set { isLoading = newValue }
    }
    private var isLoadingMoreArchivedSessions: Bool {
        get { isLoadingMore }
        set { isLoadingMore = newValue }
    }
    private var archivedSessionsHasMore: Bool {
        get { hasMore }
        set { hasMore = newValue }
    }
    private var archivedSessionsLoadError: String? {
        get { loadError }
        set { loadError = newValue }
    }
    private var archivedSessionsNextCursor: String? {
        get { nextCursor }
        set { nextCursor = newValue }
    }
    private var archivedSessionsKind: SessionKind? {
        get { sessionKind }
        set { sessionKind = newValue }
    }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, urlSession: URLSession, selection: SessionSelectionController,
         currentError: @escaping () -> String?, reportError: @escaping (String?) -> Void) {
        self.baseURL = baseURL
        self.urlSession = urlSession
        self.selection = selection
        self.currentError = currentError
        self.reportError = reportError
    }

    func reset() {
        sessions = []
        nextCursor = nil
        hasMore = false
        loadError = nil
    }

    func refreshArchivedSessions(sessionKind: SessionKind? = nil) async {
        guard !isLoadingArchivedSessions, !isLoadingMoreArchivedSessions else { return }
        archivedSessionsKind = sessionKind
        isLoadingArchivedSessions = true
        defer { isLoadingArchivedSessions = false }
        await loadArchivedSessionPage(reset: true)
    }

    func loadMoreArchivedSessions() async {
        guard archivedSessionsHasMore,
              archivedSessionsNextCursor != nil,
              !isLoadingArchivedSessions,
              !isLoadingMoreArchivedSessions else { return }
        isLoadingMoreArchivedSessions = true
        defer { isLoadingMoreArchivedSessions = false }
        await loadArchivedSessionPage(reset: false)
    }

    /// Resolves one archived Session through an indexed lookup. Deep links do
    /// not walk every archive page just to locate a single durable Session.
    func loadArchivedSession(id: String) async -> TaskSession? {
        do {
            var components = URLComponents(url: baseURL.appending(path: "sessions"), resolvingAgainstBaseURL: false)!
            components.queryItems = [
                URLQueryItem(name: "archived", value: "true"),
                URLQueryItem(name: "sessionId", value: id),
                URLQueryItem(name: "limit", value: "1")
            ]
            let (data, response) = try await urlSession.data(from: components.url!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            guard let session = try JSONDecoder().decode(SessionsResponse.self, from: data).sessions.first,
                  session.archived == true else { return nil }
            if let index = archivedSessions.firstIndex(where: { $0.id == session.id }) {
                archivedSessions[index] = session
            } else {
                archivedSessions.append(session)
            }
            archivedSessionsLoadError = nil
            return session
        } catch {
            archivedSessionsLoadError = error.localizedDescription
            return nil
        }
    }

    private func loadArchivedSessionPage(reset: Bool) async {
        do {
            var components = URLComponents(url: baseURL.appending(path: "sessions"), resolvingAgainstBaseURL: false)!
            var queryItems = [
                URLQueryItem(name: "archived", value: "true"),
                URLQueryItem(name: "limit", value: "50")
            ]
            if let archivedSessionsKind {
                queryItems.append(URLQueryItem(name: "sessionKind", value: archivedSessionsKind.rawValue))
            }
            if !reset, let archivedSessionsNextCursor {
                queryItems.append(URLQueryItem(name: "cursor", value: archivedSessionsNextCursor))
            }
            components.queryItems = queryItems
            let (data, response) = try await urlSession.data(from: components.url!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(SessionsResponse.self, from: data)
            let pageSessions = decoded.sessions.filter { $0.archived == true }
            let explicitlyArchivedSessions: [TaskSession]
            if reset {
                explicitlyArchivedSessions = pageSessions
            } else {
                var byID = Dictionary(uniqueKeysWithValues: archivedSessions.map { ($0.id, $0) })
                pageSessions.forEach { byID[$0.id] = $0 }
                explicitlyArchivedSessions = archivedSessions.compactMap { byID.removeValue(forKey: $0.id) }
                    + pageSessions.compactMap { byID.removeValue(forKey: $0.id) }
            }
            if archivedSessions != explicitlyArchivedSessions {
                let selectedID = selection.selectedSessionID
                let previousSelected = selectedID.flatMap { id in
                    archivedSessions.first(where: { $0.id == id })
                }
                archivedSessions = explicitlyArchivedSessions
                let nextSelected = selectedID.flatMap { id in
                    explicitlyArchivedSessions.first(where: { $0.id == id })
                }
                if previousSelected != nextSelected, let selectedID {
                    selection.notifySelectedSessionChanged(selectedID)
                }
            }
            archivedSessionsHasMore = decoded.page?.hasMore ?? false
            archivedSessionsNextCursor = decoded.page?.nextCursor
            archivedSessionsLoadError = nil
            if lastError != nil {
                lastError = nil
            }
        } catch {
            let message = error.localizedDescription
            archivedSessionsLoadError = message
            if lastError != message {
                lastError = message
            }
        }
    }
}
