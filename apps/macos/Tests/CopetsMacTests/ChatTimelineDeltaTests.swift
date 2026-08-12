import Foundation
import XCTest
@testable import CorptieMac

final class ChatTimelineDeltaTests: XCTestCase {
    func testSnapshotHeaderSupportsLegacyAndVersionedFrames() async throws {
        let legacy = try await ChatTimelineDeltaDecoder.snapshotHeader(
            from: Data(#"{"session":{}}"#.utf8)
        )
        XCTAssertNil(legacy.protocolVersion)
        XCTAssertNil(legacy.revision)

        let versioned = try await ChatTimelineDeltaDecoder.snapshotHeader(
            from: Data(#"{"protocolVersion":1,"revision":12,"session":{}}"#.utf8)
        )
        XCTAssertEqual(versioned.protocolVersion, 1)
        XCTAssertEqual(versioned.revision, 12)
    }

    func testAppendUpdateAndMetadataUseStrictRevisionChain() throws {
        let initial = detail(items: [item(id: "user", text: "Start")])
        let appended = try envelope(#"{"protocolVersion":1,"baseRevision":1,"revision":2,"metadata":\#(metadataJSON(updatedAt: "two")),"items":[\#(itemJSON(id: "agent", text: "R"))]}"#)
        let appendResult = ChatTimelineDeltaMerger.merge(
            kind: .itemsAppended,
            envelope: appended,
            currentDetail: initial,
            currentRevision: 1
        )
        guard case .applied(let afterAppend, let appendRevision) = appendResult else {
            return XCTFail("Append was not applied")
        }
        XCTAssertEqual(appendRevision, 2)
        XCTAssertEqual(afterAppend.items.map(\.id), ["user", "agent"])

        let updated = try envelope(#"{"protocolVersion":1,"baseRevision":2,"revision":3,"metadata":\#(metadataJSON(updatedAt: "three")),"index":1,"item":\#(itemJSON(id: "agent", text: "Ready"))}"#)
        let updateResult = ChatTimelineDeltaMerger.merge(
            kind: .itemUpdated,
            envelope: updated,
            currentDetail: afterAppend,
            currentRevision: appendRevision
        )
        guard case .applied(let afterUpdate, let updateRevision) = updateResult else {
            return XCTFail("Update was not applied")
        }
        XCTAssertEqual(afterUpdate.items.last?.text, "Ready")

        let metadata = try envelope(#"{"protocolVersion":1,"baseRevision":3,"revision":4,"metadata":\#(metadataJSON(status: "complete", updatedAt: "four"))}"#)
        let metadataResult = ChatTimelineDeltaMerger.merge(
            kind: .metadataUpdated,
            envelope: metadata,
            currentDetail: afterUpdate,
            currentRevision: updateRevision
        )
        guard case .applied(let completed, let revision) = metadataResult else {
            return XCTFail("Metadata was not applied")
        }
        XCTAssertEqual(revision, 4)
        XCTAssertEqual(completed.status, .complete)
        XCTAssertEqual(completed.items, afterUpdate.items)
    }

    func testDuplicateIsIdempotentAndGapRequiresSnapshot() throws {
        let current = detail(items: [item(id: "user", text: "Start")])
        let duplicate = try envelope(#"{"protocolVersion":1,"baseRevision":1,"revision":2,"metadata":\#(metadataJSON()),"items":[\#(itemJSON(id: "agent", text: "R"))]}"#)
        XCTAssertEqual(
            ChatTimelineDeltaMerger.merge(kind: .itemsAppended, envelope: duplicate, currentDetail: current, currentRevision: 2),
            .duplicate
        )

        let gap = try envelope(#"{"protocolVersion":1,"baseRevision":4,"revision":5,"metadata":\#(metadataJSON()),"items":[\#(itemJSON(id: "agent", text: "R"))]}"#)
        XCTAssertEqual(
            ChatTimelineDeltaMerger.merge(kind: .itemsAppended, envelope: gap, currentDetail: current, currentRevision: 2),
            .requiresSnapshot
        )
    }

    func testInvalidIndexIDAndDuplicateAppendRequireSnapshot() throws {
        let current = detail(items: [item(id: "user", text: "Start")])
        let wrongItem = try envelope(#"{"protocolVersion":1,"baseRevision":1,"revision":2,"metadata":\#(metadataJSON()),"index":0,"item":\#(itemJSON(id: "other", text: "R"))}"#)
        XCTAssertEqual(
            ChatTimelineDeltaMerger.merge(kind: .itemUpdated, envelope: wrongItem, currentDetail: current, currentRevision: 1),
            .requiresSnapshot
        )
        let duplicate = try envelope(#"{"protocolVersion":1,"baseRevision":1,"revision":2,"metadata":\#(metadataJSON()),"items":[\#(itemJSON(id: "user", text: "Again"))]}"#)
        XCTAssertEqual(
            ChatTimelineDeltaMerger.merge(kind: .itemsAppended, envelope: duplicate, currentDetail: current, currentRevision: 1),
            .requiresSnapshot
        )
    }

    func testAuthoritativeWorkspacePathWinsOverProviderMetadata() throws {
        let current = detail(items: [item(id: "user", text: "Start")])
        let metadata = try envelope(#"{"protocolVersion":1,"baseRevision":1,"revision":2,"metadata":\#(metadataJSON())}"#)
        let result = ChatTimelineDeltaMerger.merge(
            kind: .metadataUpdated,
            envelope: metadata,
            currentDetail: current,
            currentRevision: 1,
            preferredCwd: "/authoritative/worktree"
        )
        guard case .applied(let detail, _) = result else {
            return XCTFail("Metadata was not applied")
        }
        XCTAssertEqual(detail.cwd, "/authoritative/worktree")
    }

    private func envelope(_ json: String) throws -> ChatTimelineDeltaEnvelope {
        try JSONDecoder().decode(ChatTimelineDeltaEnvelope.self, from: Data(json.utf8))
    }

    private func detail(items: [CodexThreadItem]) -> CodexThreadDetail {
        CodexThreadDetail(
            id: "thread",
            title: "Agent",
            status: .running,
            source: "provider",
            connectionStatus: "connected",
            currentModel: nil,
            currentReasoningLevel: nil,
            activityStatus: "Working",
            cwd: "/tmp",
            createdAt: "one",
            updatedAt: "one",
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: nil,
            turnCount: 1,
            items: items
        )
    }

    private func item(id: String, text: String) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn",
            turnStatus: "running",
            type: id == "user" ? "userMessage" : "agentMessage",
            title: "Title",
            text: text,
            options: nil,
            status: nil,
            createdAt: "one"
        )
    }

    private func metadataJSON(status: String = "running", updatedAt: String = "two") -> String {
        #"{"title":"Agent","status":"\#(status)","source":"provider","connectionStatus":"connected","currentModel":null,"currentReasoningLevel":null,"activityStatus":"Working","cwd":"/tmp","createdAt":"one","updatedAt":"\#(updatedAt)","canSend":true,"sendUnavailableReason":null,"capabilities":null,"turnCount":1,"actions":null}"#
    }

    private func itemJSON(id: String, text: String) -> String {
        #"{"id":"\#(id)","turnId":"turn","turnStatus":"running","type":"agentMessage","title":"Agent","text":"\#(text)","options":null,"status":null,"createdAt":"one"}"#
    }
}
