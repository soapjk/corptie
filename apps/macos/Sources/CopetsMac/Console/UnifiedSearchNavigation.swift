import Foundation
import SwiftUI
import CorptieClientCore

@MainActor
final class UnifiedSearchNavigation: ObservableObject {
    static let shared = UnifiedSearchNavigation()
    struct Target: Equatable {
        let token: UUID
        let sessionID: String
        let messageID: String
    }
    @Published private(set) var target: Target?
    @Published private(set) var matches: [UnifiedSearchHit] = []
    @Published var error: String?
    func setMatches(_ hits: [UnifiedSearchHit], sessionID: String) {
        matches = Array(hits.filter { $0.sessionId == sessionID && $0.messageId != nil }.prefix(300))
    }
    func step(_ delta: Int) {
        guard let target, let index = matches.firstIndex(where: { $0.messageId == target.messageID }),
              matches.indices.contains(index + delta), let id = matches[index + delta].messageId else { return }
        request(sessionID: target.sessionID, messageID: id)
    }
    func request(sessionID: String, messageID: String) {
        error = nil
        target = Target(token: UUID(), sessionID: sessionID, messageID: messageID)
    }
}

struct SearchMessageNavigationBar: View {
    let sessionID: String
    @ObservedObject private var navigation = UnifiedSearchNavigation.shared
    private var index: Int? {
        navigation.matches.firstIndex { $0.messageId == navigation.target?.messageID }
    }
    var body: some View {
        if navigation.target?.sessionID == sessionID, let index, !navigation.matches.isEmpty {
            HStack {
                Text(L10n("Search match") + " \(index + 1)/\(navigation.matches.count)").font(.caption).foregroundStyle(.secondary)
                Button(L10n("Previous match"), systemImage: "chevron.up") { navigation.step(-1) }.disabled(index == 0)
                Button(L10n("Next match"), systemImage: "chevron.down") { navigation.step(1) }.disabled(index + 1 == navigation.matches.count)
                Spacer()
            }.controlSize(.small)
        }
    }
}

extension UnifiedConsoleView {
    func openSearchHit(_ hit: UnifiedSearchHit) async throws {
        if let sessionID = hit.sessionId, hit.kind == "session" || hit.kind == "message" {
            var session = backendClient.sessions.first(where: { $0.id == sessionID })
                ?? backendClient.archivedSessions.first(where: { $0.id == sessionID })
            if session == nil { session = await backendClient.loadArchivedSession(id: sessionID) }
            try Task.checkCancellation()
            guard let session else { throw BackendError.message(L10n("This conversation no longer exists.")) }
            isShowingWorkerArchive = isArchivedWorkerSession(session)
            selectSessionAfterHighlight(session)
            if let messageID = hit.messageId {
                UnifiedSearchNavigation.shared.request(sessionID: sessionID, messageID: messageID)
            }
            return
        }
        if hit.kind == "task" {
            let (data, response) = try await URLSession.shared.data(from: backendClient.baseURL.appending(path: "tasks/\(hit.resourceId)"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BackendError.message(L10n("This Task no longer exists.")) }
            try Task.checkCancellation()
            let task = try JSONDecoder().decode(CorptieTask.self, from: data)
            AppStateStore.shared.acceptCorptieTask(task)
            openTask(task, session: nil)
        } else if hit.kind == "work" {
            let (data, response) = try await URLSession.shared.data(from: backendClient.baseURL.appending(path: "works/\(hit.resourceId)"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BackendError.message(L10n("This Work no longer exists.")) }
            try Task.checkCancellation()
            AppStateStore.shared.hydrate(works: [try JSONDecoder().decode(Work.self, from: data)])
            selectedCategory = .worker; selectedWorkId = hit.resourceId; selectedTaskId = nil
            backendClient.closeDetail()
        }
    }
}
