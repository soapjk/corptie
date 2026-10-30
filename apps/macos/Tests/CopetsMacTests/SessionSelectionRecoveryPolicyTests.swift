import Testing
@testable import CorptieMac

struct SessionSelectionRecoveryPolicyTests {
    @Test func recordsMostRecentlyOpenedSessionWithoutDuplicates() {
        #expect(SessionSelectionRecoveryPolicy.recording(
            "session:two",
            in: ["session:one", "session:two", "session:three"]
        ) == ["session:two", "session:one", "session:three"])
    }

    @Test func startupRestoresTheMostRecentlyOpenedValidSessionAcrossCategories() {
        let older = session("older")
        var latest = session("latest")
        latest.sessionKind = .assistantChat
        #expect(SessionSelectionRecoveryPolicy.restoring(
            recentSessionIDs: ["latest", "older"], sessions: [older, latest]) == "latest")
    }

    @Test func startupSkipsRemovedArchivedAndUnclassifiedSessions() {
        let archived = session("archived", archived: true)
        var legacy = session("legacy")
        legacy.sessionKind = .legacy
        #expect(SessionSelectionRecoveryPolicy.restoring(
            recentSessionIDs: ["removed", "archived", "legacy", "valid"],
            sessions: [session("valid"), archived, legacy]) == "valid")
        #expect(SessionSelectionRecoveryPolicy.restoring(recentSessionIDs: [], sessions: [session("valid")]) == nil)
        #expect(SessionSelectionRecoveryPolicy.restoring(recentSessionIDs: ["removed"], sessions: []) == nil)
    }

    private func session(_ id: String, archived: Bool = false) -> TaskSession {
        TaskSession(id: id, title: id, agent: "Agent", agentId: "agent:one",
            sessionKind: .worker, workId: "work:one", taskId: "task:one",
            status: .complete, progress: 1, summary: "", suggestedOptions: nil,
            suggestedPrompt: nil, activityStatus: nil, updatedAt: "2026-10-30T00:00:00Z",
            accent: .cyan, archived: archived, pinned: false, sortOrder: nil,
            capabilities: nil, external: nil, actions: nil)
    }

}
