import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct SessionForkBackgroundOperationTests {
    @Test
    func submissionReturnsBeforeWorkCompletesAndDeduplicatesRequest() async {
        let background = SessionForkBackgroundOperation()
        let gate = AsyncStream<Void>.makeStream()
        var completed = false
        var duplicateStarted = false

        background.run(requestID: "fork:test") {
            for await _ in gate.stream { break }
            completed = true
        }
        background.run(requestID: "fork:test") { duplicateStarted = true }

        #expect(background.isRunning("fork:test"))
        #expect(!completed)
        #expect(!duplicateStarted)

        gate.continuation.yield()
        for _ in 0..<100 where background.isRunning("fork:test") { await Task.yield() }
        #expect(completed)
        #expect(!background.isRunning("fork:test"))
        #expect(!duplicateStarted)
    }

    @Test
    func sheetDismissesBeforeAwaitingForkAndNotifiesWithoutAutoSelection() throws {
        let source = try String(contentsOf: sourceURL(), encoding: .utf8)
        let create = try #require(source.range(of: "@MainActor private func create()"))
        let body = source[create.lowerBound...]
        #expect(body.contains("SessionForkBackgroundOperation.shared.run(requestID: requestID)"))
        #expect(body.contains("        dismiss()"))
        #expect(body.contains("selectImmediately: false"))
        #expect(!body.contains("backendClient.select(session:"))
        #expect(body.contains("OperationNotificationManager.shared.complete"))
    }

    private func sourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/CopetsMac/SessionForkSheet.swift")
    }
}
