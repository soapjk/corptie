import Foundation
import Testing
@testable import CorptieMac

struct SessionMessageLoadFailureInteractionTests {
    @Test
    func failedColdHistoryLoadPublishesAnActionableErrorAndEndsLoading() throws {
        let sync = try source("Backend/SessionTimelineSyncController.swift")
        let backend = try source("BackendClient.swift")
        let readAPI = try source("Backend/SessionTimelineReadAPI.swift")
        let failureStart = try #require(sync.range(of: "case .failure(let error):"))
        let failureEnd = try #require(sync.range(
            of: "return false",
            range: failureStart.upperBound..<sync.endIndex
        ))
        let failureBody = sync[failureStart.lowerBound..<failureEnd.upperBound]

        #expect(failureBody.contains("reportSelectedLoadError(L10nFormat("))
        #expect(failureBody.contains("Could not load session messages: %@"))
        #expect(backend.contains("self?.selectedTimelineLoadError = message"))
        #expect(backend.contains("self?.isLoadingDetail = false"))
        #expect(readAPI.contains("async -> Result<(detail: CodexThreadDetail, timelineRevision: Int), Error>"))
        #expect(readAPI.contains("let serverMessage = errorMessage(data)"))
    }

    @Test
    func messageFailureSurfaceOffersRetryThroughTheSameSelectedSessionLoader() throws {
        let view = try source("Conversation/SessionConversationContent.swift")
        let emptyStates = try source("Conversation/ConversationEmptyStates.swift")
        let failureViewStart = try #require(emptyStates.range(of: "struct SessionMessageLoadFailureView"))
        let failureView = emptyStates[failureViewStart.lowerBound..<emptyStates.endIndex]

        #expect(view.contains("backendClient.selectedTimelineLoadError"))
        #expect(view.contains("Task { await backendClient.reloadSelectedSessionMessages() }"))
        #expect(failureView.contains("Text(L10n(\"Messages could not be loaded\"))"))
        #expect(failureView.contains("Button(L10n(\"Reload messages\"), action: retry)"))
    }

    private func source(_ fileName: String) throws -> String {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        return try String(
            contentsOf: sourceRoot.appendingPathComponent(fileName),
            encoding: .utf8
        )
    }
}
