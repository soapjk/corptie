import Foundation
import Testing
@testable import CorptieMac

struct SessionExecutionStatusTests {
    @Test func authoritativeExecutionStatusOverridesStaleLegacyStatus() throws {
        let data = try #require("""
        {
          "id":"session:one","title":"One","agent":"Agent","status":"running",
          "executionStatus":"completed","deliveryStatus":"completed",
          "providerConnectionStatus":"connected","syncHealth":"healthy",
          "progress":1,"summary":"Done","updatedAt":"2026-08-26T10:00:00Z",
          "accent":"cyan"
        }
        """.data(using: .utf8))

        let session = try JSONDecoder().decode(TaskSession.self, from: data)

        #expect(session.status == .running)
        #expect(session.executionTaskStatus == .complete)
        #expect(session.deliveryStatus == "completed")
        #expect(session.isConnected)
        #expect(session.syncHealth == "healthy")
    }

    @Test func olderStoredPayloadFallsBackToLegacyStatus() throws {
        let data = try #require("""
        {
          "id":"session:legacy","title":"Legacy","agent":"Agent","status":"failed",
          "progress":1,"summary":"Failed","updatedAt":"2026-08-26T10:00:00Z",
          "accent":"amber"
        }
        """.data(using: .utf8))

        let session = try JSONDecoder().decode(TaskSession.self, from: data)
        #expect(session.executionTaskStatus == .failed)
    }

    @MainActor @Test func readinessIsIndependentFromExecutionAndCarriesTheDisableReason() throws {
        let data = try #require("""
        {
          "id":"session:not-ready","title":"Not Ready","agent":"Agent","status":"complete",
          "readiness":"not_ready",
          "notReadyReason":{"code":"PROVIDER_INITIALIZING","message":"Provider is preparing.","retryable":true},
          "progress":1,"summary":"Waiting","updatedAt":"2026-08-31T10:00:00Z",
          "accent":"cyan",
          "capabilities":{"canSend":true},
          "actions":{"send":{"available":true},"interrupt":{"available":false},"approve":{"available":false},"switchModel":{"available":true},"switchReasoning":{"available":true},"switchWorkspace":{"available":true},"switchProvider":{"available":true}}
        }
        """.data(using: .utf8))

        let session = try JSONDecoder().decode(TaskSession.self, from: data)
        #expect(session.executionTaskStatus == .complete)
        #expect(session.readiness == .notReady)
        #expect(session.isReady == false)
        #expect(session.notReadyReason?.code == "PROVIDER_INITIALIZING")
        #expect(session.notReadyReason?.presentationTitle == L10n("Starting Provider Runtime"))
        #expect(session.notReadyReason?.presentationMessage == L10n("The Provider process is starting. This does not rebuild this Session or replace its Provider Thread."))
    }

    @MainActor @Test func bindingVerificationExplicitlySaysTheExistingThreadIsPreserved() {
        let reason = SessionNotReadyReason(
            code: "BINDING_RUNTIME_VERIFYING",
            message: "Verifying.",
            retryable: true
        )
        #expect(reason.presentationTitle == L10n("Reconnecting Existing Session"))
        #expect(reason.presentationMessage == L10n("Corptie is reconnecting the existing Provider Thread. No new Thread or context rebuild is being created."))
    }
}
