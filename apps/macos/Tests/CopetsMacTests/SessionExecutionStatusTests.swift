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
}
