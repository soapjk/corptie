import Foundation
import Testing

@testable import CorptieMac

struct BackendTimelineAuthorityTests {
    @Test func localFeedbackPrecedesNetworkButAcknowledgementRequiresSuccess() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/CopetsMac/Backend/SessionMessageController.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let acknowledgement = try #require(source.range(
            of: "guard (200..<300).contains(httpResponse.statusCode)"
        ))
        let publication = try #require(source.range(
            of: "appendAcknowledgedUserMessage("
        ))

        #expect(publication.lowerBound > acknowledgement.upperBound)
        let localFeedback = try #require(source.range(of: "timelineLocalOverlay.acknowledge(trimmed"))
        let requestTask = try #require(source.range(of: "        Task {"))
        #expect(localFeedback.lowerBound < requestTask.lowerBound)
        #expect(source.contains("submitting: true"))
        #expect(!source.contains("appendOptimisticUserMessage"))
        #expect(source.contains("backend creates the MessageDelivery and its session_items"))
    }
}
