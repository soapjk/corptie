import Foundation
import Testing

@testable import CorptieMac

struct ProjectStatusRefreshLifecycleTests {
    @Test
    func projectStatusUsesEventRefreshAndLowFrequencyFallback() throws {
        let source = try backendClientSource() + projectWorkspaceSource()
            + backendEventRouterSource()
        let controller = try workspaceStatusSource()
        #expect(controller.contains("Task.sleep(for: .seconds(60))"))
        #expect(!projectStatusRefreshBlock(controller).contains("Task.sleep(for: .seconds(5))"))
        #expect(source.contains("workspaceStatusController.startProjectStatusFallbackRefresh"))
        #expect(source.contains("eventName == \"ProjectWorkspaceChanged\""))
        #expect(source.contains("eventName == \"ProjectWorktreeIntegrationStarted\""))
        #expect(source.contains("eventName == \"ProjectWorktreeIntegrationCompleted\""))
        #expect(source.contains("scheduleSelectedProjectStatusEventRefresh(data: data)"))
    }

    @Test
    func pageAndApplicationLifecycleCancelProjectStatusTasks() throws {
        let source = try backendClientSource()
        let close = functionBody(named: "func closeDetail()", in: source)
        let resign = functionBody(named: "func applicationDidResignActive()", in: try projectWorkspaceSource())
        #expect(close.contains("workspaceStatusController.stopRefreshing()"))
        #expect(resign.contains("workspaceStatusController.stopRefreshing()"))
        let stop = functionBody(named: "func stopRefreshing()", in: try workspaceStatusSource())
        #expect(stop.contains("projectStatusRefreshTask?.cancel()"))
        #expect(stop.contains("projectStatusEventRefreshTask?.cancel()"))
        #expect(stop.contains("projectStatusRefreshTask = nil"))
        #expect(stop.contains("projectStatusEventRefreshTask = nil"))
    }

    @Test
    func selectionAndOpeningNeverPrepareProviderExecution() throws {
        let source = try selectionSource()
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
            contentsOf: root.appendingPathComponent("Sources/CopetsMac/UnifiedConsoleView.swift"),
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

    private func selectionSource() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(
            "Sources/CopetsMac/Backend/BackendClientSelection.swift"), encoding: .utf8)
    }

    private func projectWorkspaceSource() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(
            "Sources/CopetsMac/Backend/BackendClientProjectWorkspace.swift"), encoding: .utf8)
    }

    private func backendEventRouterSource() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(
            "Sources/CopetsMac/Backend/BackendEventRouter.swift"), encoding: .utf8)
    }

    private func projectStatusRefreshBlock(_ source: String) -> String {
        functionBody(named: "func startProjectStatusFallbackRefresh(", in: source)
    }

    private func workspaceStatusSource() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(
            contentsOf: root.appendingPathComponent("Sources/CopetsMac/Backend/ProjectWorkspaceStatusController.swift"),
            encoding: .utf8
        )
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
