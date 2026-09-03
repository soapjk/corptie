import Foundation
import Testing

@testable import CorptieMac

struct ArchivedSessionPaginationTests {
    @Test
    func archiveRequestsUseBoundedCursorPagesAndExposeProgress() throws {
        let sources = try sourceFiles()
        let backend = sources.backend

        #expect(backend.contains("URLQueryItem(name: \"limit\", value: \"50\")"))
        #expect(backend.contains("URLQueryItem(name: \"cursor\", value: archivedSessionsNextCursor)"))
        #expect(backend.contains("URLQueryItem(name: \"sessionKind\", value: archivedSessionsKind.rawValue)"))
        #expect(backend.contains("archivedSessionsHasMore = decoded.page?.hasMore"))
        #expect(backend.contains("func loadMoreArchivedSessions() async"))
        #expect(backend.contains("func loadArchivedSession(id: String) async -> TaskSession?"))
        #expect(backend.contains("URLQueryItem(name: \"sessionId\", value: id)"))
        #expect(sources.settings.contains("More archived sessions are available."))
        #expect(sources.settings.contains("Could not load more archived sessions"))
        #expect(sources.console.contains("More archived sessions"))
        #expect(sources.settings.contains("refreshArchivedSessions(sessionKind: .assistantChat)"))
        #expect(sources.console.contains("refreshArchivedSessions(sessionKind: .worker)"))
        #expect(sources.console.contains("archivedWorkerSessionList(work)"))
        #expect(sources.console.contains("loadArchivedSession(id: pendingId)"))
    }

    private func sourceFiles() throws -> (backend: String, settings: String, console: String) {
        let testFile = URL(fileURLWithPath: #filePath)
        let root = testFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return (
            try String(contentsOf: root.appendingPathComponent("Sources/CopetsMac/BackendClient.swift"), encoding: .utf8),
            try String(contentsOf: root.appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift"), encoding: .utf8),
            try String(contentsOf: root.appendingPathComponent("Sources/CopetsMac/UnifiedConsoleView.swift"), encoding: .utf8)
        )
    }
}
