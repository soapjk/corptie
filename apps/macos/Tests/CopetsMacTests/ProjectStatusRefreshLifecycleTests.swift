import Foundation
import Testing

@testable import CorptieMac

struct ProjectStatusRefreshLifecycleTests {
    @Test
    func projectStatusUsesEventRefreshAndLowFrequencyFallback() throws {
        let source = try backendClientSource()
        #expect(source.contains("Task.sleep(for: .seconds(60))"))
        #expect(!projectStatusRefreshBlock(source).contains("Task.sleep(for: .seconds(5))"))
        #expect(source.contains("eventName == \"ProjectWorkspaceChanged\""))
        #expect(source.contains("eventName == \"ProjectWorktreeIntegrationStarted\""))
        #expect(source.contains("eventName == \"ProjectWorktreeIntegrationCompleted\""))
        #expect(source.contains("scheduleSelectedProjectStatusEventRefresh(data: data)"))
    }

    @Test
    func pageAndApplicationLifecycleCancelProjectStatusTasks() throws {
        let source = try backendClientSource()
        let close = functionBody(named: "func closeDetail()", in: source)
        let resign = functionBody(named: "func applicationDidResignActive()", in: source)
        #expect(close.contains("projectStatusRefreshTask?.cancel()"))
        #expect(close.contains("projectStatusEventRefreshTask?.cancel()"))
        #expect(resign.contains("projectStatusRefreshTask?.cancel()"))
        #expect(resign.contains("projectStatusEventRefreshTask?.cancel()"))
    }

    @Test
    func selectionAndOpeningNeverPrepareProviderExecution() throws {
        let source = try backendClientSource()
        let selection = functionBody(named: "func select(session: TaskSession)", in: source)
        #expect(!source.contains("scheduleExecutionPreparation"))
        #expect(!source.contains("prepare-execution"))
        #expect(!selection.contains("sessionApplicationService"))
    }

    @Test
    func selectionHasOneStoredAuthority() throws {
        let backend = try backendClientSource()
        let testFile = URL(fileURLWithPath: #filePath)
        let root = testFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let sessionsView = try String(
            contentsOf: root.appendingPathComponent("Sources/CopetsMac/SessionsView.swift"),
            encoding: .utf8
        )

        #expect(backend.contains("guard let id = sessionSelectionController.selectedSessionID"))
        #expect(!backend.contains("@Published private(set) var selectedSession"))
        #expect(!backend.contains("private var selectionGeneration"))
        #expect(!sessionsView.contains("@State private var selectedSession"))
    }

    private func backendClientSource() throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let root = testFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Sources/CopetsMac/BackendClient.swift"), encoding: .utf8)
    }

    private func projectStatusRefreshBlock(_ source: String) -> String {
        functionBody(named: "private func startProjectStatusFallbackRefresh(", in: source)
    }

    private func functionBody(named marker: String, in source: String) -> String {
        guard let start = source.range(of: marker)?.lowerBound else { return "" }
        let suffix = source[start...]
        guard let next = suffix.dropFirst(marker.count).range(of: "\n    private func ")?.lowerBound else {
            return String(suffix)
        }
        return String(suffix[..<next])
    }
}
