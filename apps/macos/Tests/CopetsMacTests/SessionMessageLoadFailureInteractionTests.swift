import Foundation
import Testing
@testable import CorptieMac

struct SessionMessageLoadFailureInteractionTests {
    @Test
    func failedColdHistoryLoadPublishesAnActionableErrorAndEndsLoading() throws {
        let backend = try source("BackendClient.swift")
        let failureStart = try #require(backend.range(of: "case .failure(let error):"))
        let failureEnd = try #require(backend.range(
            of: "return false",
            range: failureStart.upperBound..<backend.endIndex
        ))
        let failureBody = backend[failureStart.lowerBound..<failureEnd.upperBound]

        #expect(failureBody.contains("selectedTimelineLoadError = L10nFormat("))
        #expect(failureBody.contains("Could not load session messages: %@"))
        #expect(failureBody.contains("isLoadingDetail = false"))
        #expect(backend.contains("async -> Result<(detail: CodexThreadDetail, timelineRevision: Int), Error>"))
        #expect(backend.contains("Self.errorMessage(from: data)"))
    }

    @Test
    func messageFailureSurfaceOffersRetryThroughTheSameSelectedSessionLoader() throws {
        let view = try source("FloatingRootView.swift")
        let failureViewStart = try #require(view.range(of: "private struct SessionMessageLoadFailureView"))
        let failureView = view[failureViewStart.lowerBound..<view.endIndex]

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
