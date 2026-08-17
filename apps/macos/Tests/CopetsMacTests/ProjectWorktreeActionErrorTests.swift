import Testing
@testable import CorptieMac

@MainActor
struct ProjectWorktreeActionErrorTests {
    @Test
    func actionErrorSurvivesSessionStreamReconnection() {
        let client = BackendClient()

        client.recordProjectWorktreeActionError("Merge conflict in server.mjs")
        client.markBackendConnectedFromSessionStream()

        #expect(client.lastError == nil)
        #expect(client.projectWorktreeActionError == "Merge conflict in server.mjs")
    }

    @Test
    func actionErrorCanBeDismissedExplicitly() {
        let client = BackendClient()
        client.recordProjectWorktreeActionError("Merge failed")

        client.dismissProjectWorktreeActionError()

        #expect(client.projectWorktreeActionError == nil)
    }
}
