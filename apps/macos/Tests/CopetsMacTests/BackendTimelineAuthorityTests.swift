import Foundation
import Testing

@testable import CorptieMac

struct BackendTimelineAuthorityTests {
    @Test func userMessageEchoIsPublishedOnlyAfterBackendPersistenceAcknowledgement() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/CopetsMac/BackendClient.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let acknowledgement = try #require(source.range(
            of: "guard (200..<300).contains(httpResponse.statusCode)"
        ))
        let publication = try #require(source.range(
            of: "appendAcknowledgedUserMessage("
        ))

        #expect(publication.lowerBound > acknowledgement.upperBound)
        #expect(!source.contains("appendOptimisticUserMessage"))
        #expect(source.contains("backend creates the MessageDelivery and its session_items"))
    }
}
