import AppKit
import Foundation

/// Archive, pin, order, rename and deletion commands for the Session collection.
@MainActor
final class SessionOrganizationController {
    private let baseURL: URL
    private let sessionIndexStore: SessionIndexStore
    private let activeSessions: () -> [TaskSession]
    private let currentSession: () -> TaskSession?
    private let closeDetail: () -> Void
    private let archivedSessionKind: () -> SessionKind?
    private let refreshArchivedSessions: (SessionKind?) async -> Void
    private let currentError: () -> String?
    private let reportError: (String?) -> Void
    private let errorMessage: (Data) -> String?
    private var sessionReorderRevision = 0

    private var sessions: [TaskSession] { activeSessions() }
    private var selectedSession: TaskSession? { currentSession() }
    private var archivedSessionsKind: SessionKind? { archivedSessionKind() }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, sessionIndexStore: SessionIndexStore,
         activeSessions: @escaping () -> [TaskSession],
         currentSession: @escaping () -> TaskSession?,
         closeDetail: @escaping () -> Void,
         archivedSessionKind: @escaping () -> SessionKind?,
         refreshArchivedSessions: @escaping (SessionKind?) async -> Void,
         currentError: @escaping () -> String?,
         reportError: @escaping (String?) -> Void,
         errorMessage: @escaping (Data) -> String?) {
        self.baseURL = baseURL
        self.sessionIndexStore = sessionIndexStore
        self.activeSessions = activeSessions
        self.currentSession = currentSession
        self.closeDetail = closeDetail
        self.archivedSessionKind = archivedSessionKind
        self.refreshArchivedSessions = refreshArchivedSessions
        self.currentError = currentError
        self.reportError = reportError
        self.errorMessage = errorMessage
    }

    func setArchived(_ archived: Bool, session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/archive"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["archived": archived])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refreshArchivedSessions(archivedSessionsKind)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func setPinned(_ pinned: Bool, session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/pin"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["pinned": pinned])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func moveSession(draggedSessionId: String, before targetSessionId: String?) {
        guard draggedSessionId != targetSessionId else { return }
        sessionIndexStore.move(draggedSessionId, before: targetSessionId)
    }

    func beginSessionReorder() {
        sessionReorderRevision += 1
        sessionIndexStore.beginReorder()
    }

    func persistSessionOrder() {
        let orderedIds = sessionIndexStore.orderedIDs
        let revision = sessionReorderRevision
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/reorder"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionIds": orderedIds])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                if revision == sessionReorderRevision {
                    let persistedIDs = (try? await BackendResponseDecoder.sessions(from: data).map(\.id))
                        ?? orderedIds
                    let authoritativeByID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
                    let residentByID = Dictionary(uniqueKeysWithValues: sessionIndexStore.sessions.map { ($0.id, $0) })
                    var reconciled = persistedIDs.compactMap { authoritativeByID[$0] ?? residentByID[$0] }
                    let included = Set(reconciled.map(\.id))
                    reconciled.append(contentsOf: sessions.filter { !included.contains($0.id) })
                    sessionIndexStore.endReorder(authoritativeSessions: reconciled)
                }
            } catch {
                if revision == sessionReorderRevision {
                    lastError = error.localizedDescription
                    sessionIndexStore.endReorder(authoritativeSessions: sessions)
                }
            }
        }
    }

    func rename(session: TaskSession, title: String, onSuccess: @escaping () -> Void = {}) {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            lastError = L10n("Title is required.")
            return
        }

        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)"))
                request.httpMethod = "PATCH"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["title": trimmedTitle])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409 {
                        throw BackendError.message(L10n("A session with this name already exists."))
                    }
                    throw BackendError.message(errorMessage(data) ?? L10n("Could not rename session."))
                }
                onSuccess()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func delete(session: TaskSession) {
        Task {
            do {
                let planURL = baseURL.appending(path: "sessions/\(session.id)/deletion-plan")
                let (planData, planResponse) = try await URLSession.shared.data(from: planURL)
                guard let planHTTPResponse = planResponse as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(planHTTPResponse.statusCode) else {
                    throw BackendError.message(errorMessage(planData) ?? L10n("Could not inspect the session worktree."))
                }
                let plan = try JSONDecoder().decode(SessionDeletionPlan.self, from: planData)
                var mergeWorktree = false
                if plan.workspaceUnavailable == true {
                    guard confirmOrphanedSessionDeletion(plan: plan) else { return }
                } else if plan.requiresWorktreeMerge {
                    guard let decision = confirmWorktreeDeletion(plan: plan) else { return }
                    mergeWorktree = decision
                }

                var deleteURL = baseURL.appending(path: "sessions/\(session.id)")
                if mergeWorktree {
                    deleteURL.append(queryItems: [URLQueryItem(name: "mergeWorktree", value: "true")])
                }
                var request = URLRequest(url: deleteURL)
                request.httpMethod = "DELETE"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(errorMessage(data) ?? L10n("Could not delete the session."))
                }
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refreshArchivedSessions(archivedSessionsKind)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func confirmWorktreeDeletion(plan: SessionDeletionPlan) -> Bool? {
        let branch = plan.sourceBranch ?? L10n("detached HEAD")
        let path = plan.sourcePath ?? L10n("Unknown path")
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("This session is bound to a Git worktree")
        alert.informativeText = L10nFormat(
            "Worktree “%@” at %@ can be merged locally into main before the session is deleted. If it has uncommitted changes, this session will generate the commit message. No remote push will be performed.",
            branch,
            path
        )
        alert.addButton(withTitle: L10n("Merge into main and Delete"))
        alert.addButton(withTitle: L10n("Delete Only"))
        alert.addButton(withTitle: L10n("Cancel"))
        alert.buttons[1].hasDestructiveAction = true
        switch alert.runModal() {
        case .alertFirstButtonReturn: return true
        case .alertSecondButtonReturn: return false
        default: return nil
        }
    }

    private func confirmOrphanedSessionDeletion(plan: SessionDeletionPlan) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("This session's workspace is missing")
        alert.informativeText = L10nFormat(
            "The workspace at %@ is unavailable. Corptie can delete only the session and its local conversation record; no Worktree files or Git branches will be changed.",
            plan.sourcePath ?? L10n("Unknown path")
        )
        alert.addButton(withTitle: L10n("Delete Session Only"))
        alert.addButton(withTitle: L10n("Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
    }
}
