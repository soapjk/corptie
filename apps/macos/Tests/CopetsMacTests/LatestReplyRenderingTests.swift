import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class LatestReplyRenderingTests: XCTestCase {
    func testCompletedSnapshotReplacesEarlyCommentaryAndClosesProcessCard() async throws {
        // An external read-only snapshot can exercise this same production
        // decoding/projection path without storing conversation data in Git.
        let data: Data
        if let path = ProcessInfo.processInfo.environment["CORPTIE_TIMELINE_SNAPSHOT_FIXTURE"] {
            data = try Data(contentsOf: URL(fileURLWithPath: path))
        } else {
            data = Data("""
            {"session":{"id":"thread", "title":"Session", "status":"complete",
             "createdAt":"2026-11-12T11:25:24Z", "updatedAt":"2026-11-12T11:27:40Z", "turnCount":1,
             "items":[
              {"id":"prompt", "turnId":"turn", "turnStatus":"completed", "type":"userMessage",
               "title":"You", "text":"Start", "createdAt":"2026-11-12T11:25:24Z"},
              {"id":"progress", "turnId":"turn", "turnStatus":"completed", "type":"agentMessage",
               "title":"Agent", "text":"Working on it", "presentationRole":"commentary", "createdAt":"2026-11-12T11:25:28Z"},
              {"id":"tool", "turnId":"turn", "turnStatus":"completed", "type":"commandExecution",
               "title":"Check", "text":"Passed", "status":"completed", "createdAt":"2026-11-12T11:26:17Z"},
              {"id":"final", "turnId":"turn", "turnStatus":"completed", "type":"agentMessage",
               "title":"Agent", "text":"Finished with verification", "presentationRole":"final_answer",
               "status":"completed", "createdAt":"2026-11-12T11:27:38Z"}
             ]}}
            """.utf8)
        }
        let detail = try await BackendResponseDecoder.detail(
            from: data, threadId: "thread", authoritativeCwd: nil)
        let requestedFinalID = ProcessInfo.processInfo.environment["CORPTIE_TIMELINE_FINAL_ITEM_ID"]
        let final = try XCTUnwrap(detail.items.last {
            $0.type == "agentMessage" && $0.presentationRole == "final_answer"
                && (requestedFinalID == nil || $0.id == requestedFinalID)
        })
        let state = SessionTimelineState(sessionID: "session")
        state.apply(detail, timelineRevision: 45548)
        let cache = makeDetailDisplayCache(for: try XCTUnwrap(state.presentationDetail),
            sessionId: "session", visibleMessageLimit: 20)
        let builder = ConversationNativeRowBuilder(sessionTitle: detail.title, workingDirectory: nil,
            allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in nil })
        let rows = cache.displayEntries.map { builder.nativeAppKitRow($0, expandedTurnIds: []) }
        let finalRow = try XCTUnwrap(rows.first { $0.id == "message:" + final.id })
        XCTAssertEqual(finalRow.copyText, final.presentationText ?? final.text)
        XCTAssertTrue(finalRow.showsReplyActions)
        XCTAssertFalse(finalRow.isCommentary)
        let processes = zip(cache.displayEntries, rows).filter {
            chatDisplayEntryTurnId($0.0) == final.turnId && $0.1.expandableTurnId != nil
        }.map { $0.1 }
        XCTAssertFalse(processes.isEmpty)
        XCTAssertTrue(processes.allSatisfy { $0.processState != .running })
        let finalTurnCommentary = Set(detail.items.filter {
            $0.turnId == final.turnId && $0.presentationRole == "commentary"
        }.map { "message:" + $0.id })
        XCTAssertFalse(rows.contains { finalTurnCommentary.contains($0.id) },
            "Completed reply commentary belongs inside the finished process card")
    }
}
