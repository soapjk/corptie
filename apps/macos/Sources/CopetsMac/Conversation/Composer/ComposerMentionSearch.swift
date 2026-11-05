import CorptieConversation
import Foundation
import Observation

/// One retained Session's search result. No text view, global observation,
/// filesystem cache or geometry participates in this owner's lifetime.
@MainActor @Observable
final class ComposerMentionSearch {
    struct Request: Equatable {
        let query: String?
        let catalogRevision: UInt64
        let draftRevision: UInt64
        let selectedMentions: [ConversationMention] // bounded by the existing eight-mention limit
        let active: Bool
    }

    private(set) var matches: [ComposerMentionCatalog.Index.Match] = []
    private(set) var directory: ComposerMentionCatalog.Index?
    var selectedIndex = 0
    private(set) var isLoading = false
    @ObservationIgnored private var generation: UInt64 = 0
    @ObservationIgnored private var directoryRevision: UInt64?
    @ObservationIgnored private var worker: Task<Result, Error>?
    @ObservationIgnored private var lastRequest: Request?
    @ObservationIgnored private(set) var searchCount = 0
    @ObservationIgnored private(set) var directoryBuildCount = 0
    @ObservationIgnored private(set) var candidateResolutionCount = 0

    struct Result: Sendable {
        let directory: ComposerMentionCatalog.Index
        let matches: [ComposerMentionCatalog.Index.Match]
    }

    var isPresented: Bool { isLoading || !matches.isEmpty }

    func invalidate() {
        generation &+= 1
        worker?.cancel(); worker = nil
        lastRequest = nil
        matches = []; directory = nil; directoryRevision = nil
        selectedIndex = 0; isLoading = false
    }

    func search(_ request: Request, sessionID: String, sessions: [TaskSession],
                works: [Work], draft: String) async {
        guard request.active, let query = request.query else { invalidate(); return }
        guard request != lastRequest else { return }
        lastRequest = request
        generation &+= 1
        let currentGeneration = generation
        worker?.cancel()
        let retainedDirectory = directoryRevision == request.catalogRevision ? directory : nil
        let previousSelection = matches.indices.contains(selectedIndex) ? matches[selectedIndex].id : nil
        matches = []; selectedIndex = 0; isLoading = true
        searchCount += 1
        if retainedDirectory == nil { directoryBuildCount += 1 }
        let workLabel = L10n("Work")
        let task = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let index: ComposerMentionCatalog.Index
            if let retainedDirectory { index = retainedDirectory }
            else {
                let sourceWorks = works.map { ComposerMentionCatalog.Work(id: $0.id, name: $0.name) }
                let sourceSessions = sessions.filter { $0.archived != true }.map {
                    ComposerMentionCatalog.Session(id: $0.id, title: $0.title, workId: $0.workId)
                }
                index = try ComposerMentionCatalog.Index(works: sourceWorks, sessions: sourceSessions, workLabel: workLabel)
            }
            let excluded = Set(request.selectedMentions.filter {
                draft.contains("@\($0.displayName)")
            }.map(\.id))
            return Result(directory: index, matches: try index.matches(query: query,
                currentSessionID: sessionID, activeMentionIDs: excluded))
        }
        worker = task
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            guard generation == currentGeneration else { return }
            guard !Task.isCancelled else {
                isLoading = false; worker = nil; lastRequest = nil
                return
            }
            directory = result.directory; directoryRevision = request.catalogRevision
            matches = result.matches
            if let previousSelection, let index = matches.firstIndex(where: { $0.id == previousSelection }) {
                selectedIndex = index
            }
            isLoading = false; worker = nil
        } catch {
            guard generation == currentGeneration else { return }
            matches = []; isLoading = false; worker = nil; lastRequest = nil
        }
    }

    func candidate(at index: Int) -> ComposerMentionCandidate? {
        guard matches.indices.contains(index) else { return nil }
        return candidate(for: matches[index])
    }

    func candidate(for match: ComposerMentionCatalog.Index.Match) -> ComposerMentionCandidate? {
        guard let value = directory?.suggestion(for: match) else { return nil }
        candidateResolutionCount &+= 1
        return ComposerMentionCandidate(mention: ConversationMention(
            targetType: value.kind == .work ? .work : .session,
            targetId: value.targetId, displayName: value.displayName),
            detail: value.kind == .work ? L10n("Work") : value.detail, symbol: value.symbol)
    }

    func move(_ delta: Int) {
        guard !matches.isEmpty else { return }
        selectedIndex = (selectedIndex + delta + matches.count) % matches.count
    }
}
