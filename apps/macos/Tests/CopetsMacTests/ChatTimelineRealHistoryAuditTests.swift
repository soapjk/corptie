import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class ChatTimelineRealHistoryAuditTests: XCTestCase {
    private struct SessionList: Decodable {
        let sessions: [TaskSession]
    }

    func testLargestProductionHistoriesProjectWithoutLossOrInvalidNativeRows() async throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_RUN_REAL_HISTORY_AUDIT"] == "1" else {
            throw XCTSkip("Set CORPTIE_RUN_REAL_HISTORY_AUDIT=1 to audit the local Production history read-only.")
        }
        let baseURL = URL(string: "http://127.0.0.1:47321")!
        let sessions = try JSONDecoder().decode(
            SessionList.self,
            from: Data(contentsOf: baseURL.appending(path: "sessions"))
        ).sessions
        let providers = ["codex-app-server", "claude-sdk", "openclacky"]
        var auditedProviderCount = 0

        for provider in providers {
            let candidates = sessions.filter { $0.external?.provider == provider }
            var snapshots: [(TaskSession, CodexThreadDetail)] = []
            for session in candidates {
                let data = try Data(contentsOf: baseURL.appending(path: "sessions/\(session.id)/stored-snapshot"))
                snapshots.append((
                    session,
                    try JSONDecoder().decode(UnifiedSessionSnapshotResponse.self, from: data).session
                ))
            }
            guard let largest = snapshots.max(by: { $0.1.items.count < $1.1.items.count }) else {
                continue
            }
            auditedProviderCount += 1

            let sourceItems = largest.1.items.filter { item in
                !(item.type == "taskComplete"
                    || item.title.localizedCaseInsensitiveContains("turn completed")
                    || (item.type == "agentMessage" && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
            let entries = makeChatDisplayEntries(from: sourceItems)
            let visibleEntries = visibleDetailEntries(from: entries, limit: 500)
            XCTAssertFalse(entries.isEmpty, "\(provider) \(largest.0.title)")
            XCTAssertEqual(Set(entries.map(\.id)).count, entries.count, "Duplicate display IDs in \(provider)")

            let projectedItems = entries.flatMap(underlyingItems)
            let projectedIDs = Set(projectedItems.map(\.id))
            let requiredUserIDs = Set(sourceItems.filter { $0.type == "userMessage" }.map(\.id))
            let requiredFinalIDs = Set(sourceItems.filter {
                $0.type == "agentMessage" && $0.presentationRole == "final_answer"
            }.map(\.id))
            XCTAssertTrue(requiredUserIDs.isSubset(of: projectedIDs), "Lost user messages in \(provider)")
            XCTAssertTrue(requiredFinalIDs.isSubset(of: projectedIDs), "Lost final answers in \(provider)")

            let nativeCandidates = projectedItems
            XCTAssertFalse(nativeCandidates.isEmpty)
            for item in nativeCandidates {
                let text = ChatTimelineRowRouting.displayText(for: item)
                let attributed = NativeMarkdownAttributedText.make(
                    text: text,
                    style: item.type == "userMessage" ? .user : .agent
                )
                XCTAssertFalse(attributed.string.isEmpty, "Empty native projection for \(item.id)")
                XCTAssertFalse(attributed.string.contains("```"), "Fenced code incorrectly entered native renderer")
            }

            let routingCounts = Dictionary(grouping: visibleEntries) {
                ChatTimelineRowRouting.route(for: $0).rawValue
            }.mapValues(\.count)
            let scrollMetrics = exerciseTableReuse(entries: visibleEntries)
            let pipelineMetrics = measureSnapshotPipeline(
                data: try Data(contentsOf: baseURL.appending(path: "sessions/\(largest.0.id)/stored-snapshot")),
                iterations: 30
            )
            let cellCreationLimit = Int64(max(20, visibleEntries.count / 2))
            XCTAssertLessThan(scrollMetrics.cellsCreated, cellCreationLimit)
            XCTAssertLessThan(scrollMetrics.elapsedSeconds, 5)
            XCTAssertLessThan(pipelineMetrics.p95Milliseconds, 100)
            let reportURL = URL(fileURLWithPath: "/private/tmp/corptie-dev/real-history-\(provider)-audit.txt")
            let report = "session=\(largest.0.title)\nraw=\(largest.1.items.count)\nsnapshotBytes=\(pipelineMetrics.bytes)\nentries=\(entries.count)\nvisibleEntries=\(visibleEntries.count)\nnative=\(routingCounts["native", default: 0])\ndecodeProjectP50Ms=\(String(format: "%.3f", pipelineMetrics.p50Milliseconds))\ndecodeProjectP95Ms=\(String(format: "%.3f", pipelineMetrics.p95Milliseconds))\ncellsCreated=\(scrollMetrics.cellsCreated)\nscrollSeconds=\(String(format: "%.3f", scrollMetrics.elapsedSeconds))\n"
            try report.write(to: reportURL, atomically: true, encoding: String.Encoding.utf8)
        }
        XCTAssertGreaterThan(auditedProviderCount, 0, "No local provider history was available for the audit")
    }

    private func underlyingItems(_ entry: ChatDisplayEntry) -> [CodexThreadItem] {
        switch entry.kind {
        case .message(let item):
            [item]
        case .process(_, let items):
            items
        }
    }

    private func exerciseTableReuse(
        entries: [ChatDisplayEntry]
    ) -> (cellsCreated: Int64, elapsedSeconds: Double) {
        let state = FollowState()
        let tableView = AppKitChatTimelineView.makeTableView()
        let scrollView = AppKitChatTimelineView.makeScrollView(tableView: tableView)
        let coordinator = AppKitChatTimelineView.Coordinator(
            followsLatest: Binding(get: { state.value }, set: { state.value = $0 }),
            onToggleExpansion: { _ in }
        )
        coordinator.followsLatest = false
        coordinator.attach(tableView: tableView, scrollView: scrollView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 520),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = scrollView
        window.layoutIfNeeded()

        let rows = entries.map(auditRow)
        ChatPerformanceRecorder.shared.reset()
        coordinator.apply(rows: rows)
        tableView.reloadData()
        tableView.layoutSubtreeIfNeeded()
        let clock = ContinuousClock()
        let startedAt = clock.now
        for index in rows.indices {
            tableView.scrollRowToVisible(index)
            tableView.layoutSubtreeIfNeeded()
            scrollView.displayIfNeeded()
        }
        for index in rows.indices.reversed() {
            tableView.scrollRowToVisible(index)
            tableView.layoutSubtreeIfNeeded()
            scrollView.displayIfNeeded()
        }
        if let lastIndex = rows.indices.last {
            let clipView = scrollView.contentView
            let bottomY = max(0, tableView.bounds.maxY - clipView.bounds.height)
            clipView.scroll(to: NSPoint(x: 0, y: bottomY))
            scrollView.reflectScrolledClipView(clipView)
            tableView.layoutSubtreeIfNeeded()
            let lastRowRect = tableView.rect(ofRow: lastIndex)
            XCTAssertTrue(
                tableView.visibleRect.intersects(lastRowRect),
                "Dragging to the bottom must keep the final message visible"
            )
            XCTAssertLessThanOrEqual(
                max(0, tableView.visibleRect.maxY - lastRowRect.maxY),
                tableView.intercellSpacing.height + 2,
                "The table must not expose a blank region below the final message"
            )
        }
        let elapsed = startedAt.duration(to: clock.now)
        let components = elapsed.components
        let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
        return (ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated], seconds)
    }

    private func measureSnapshotPipeline(
        data: Data,
        iterations: Int
    ) -> (bytes: Int, p50Milliseconds: Double, p95Milliseconds: Double) {
        var samples: [Double] = []
        samples.reserveCapacity(iterations)
        for _ in 0..<iterations {
            let started = ContinuousClock.now
            let detail = try! JSONDecoder().decode(UnifiedSessionSnapshotResponse.self, from: data).session
            let items = detail.items.filter { item in
                !(item.type == "taskComplete"
                    || item.title.localizedCaseInsensitiveContains("turn completed")
                    || (item.type == "agentMessage" && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
            _ = makeChatDisplayEntries(from: items)
            let elapsed = started.duration(to: .now).components
            samples.append(Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15)
        }
        samples.sort()
        let p50 = samples[min(samples.count - 1, Int(Double(samples.count - 1) * 0.50))]
        let p95 = samples[min(samples.count - 1, Int(Double(samples.count - 1) * 0.95))]
        return (data.count, p50, p95)
    }

    private func auditRow(_ entry: ChatDisplayEntry) -> AppKitChatTimelineRow {
        let item = underlyingItems(entry).first
        let text: String
        switch entry.kind {
        case .message(let message):
            text = ChatTimelineRowRouting.displayText(for: message)
        case .process:
            text = ""
        }
        let isProcess = entry.isProcessGroup
        let processItems = underlyingItems(entry)
        return AppKitChatTimelineRow(
            id: entry.id,
            contentRevision: text.hashValue,
            nativeText: text,
            copyText: text,
            nativeStyle: isProcess ? .process : (item?.type == "userMessage" ? .user : .agent),
            title: item?.title ?? "Execution process",
            metadata: "",
            expandableTurnId: nil,
            isExpanded: false,
            processCount: isProcess ? processItems.count : nil,
            processDuration: isProcess ? "1s" : nil,
            processState: processItems.contains(where: { !["complete", "completed"].contains($0.turnStatus.lowercased()) })
                ? .running
                : .completed,
            showsHeader: !isProcess
        )
    }

    private final class FollowState {
        var value = false
    }
}
