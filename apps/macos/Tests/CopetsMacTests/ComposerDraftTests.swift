import XCTest
@testable import CorptieMac

final class ComposerDraftTests: XCTestCase {
    func testDraftRepositoryKeepsIndependentDraftsPerSession() async {
        await MainActor.run {
            let repository = ComposerDraftRepository()
            let first = repository.draft(for: "session-1")
            let second = repository.draft(for: "session-2")

            first.updateFromEditor("first draft")
            second.updateFromEditor("second draft")

            XCTAssertTrue(first === repository.draft(for: "session-1"))
            XCTAssertTrue(second === repository.draft(for: "session-2"))
            XCTAssertEqual(first.text, "first draft")
            XCTAssertEqual(second.text, "second draft")
        }
    }

    func testSendableStateIgnoresWhitespaceOnlyDrafts() async {
        await MainActor.run {
            let draft = ComposerDraftBuffer()

            draft.updateFromEditor(" \n\t")
            XCTAssertFalse(draft.hasSendableText)
            XCTAssertNil(draft.submission())

            draft.updateFromEditor(" \nhello")
            XCTAssertTrue(draft.hasSendableText)
            XCTAssertEqual(draft.submission()?.text, " \nhello")
        }
    }

    func testSuccessfulSubmissionClearsOnlyTheSubmittedRevision() async throws {
        try await MainActor.run {
            let draft = ComposerDraftBuffer(text: "first")
            let submission = try XCTUnwrap(draft.submission())

            XCTAssertTrue(draft.clear(ifUnchangedSince: submission))
            XCTAssertEqual(draft.text, "")
            XCTAssertFalse(draft.hasSendableText)
        }
    }

    func testLateSuccessCannotEraseNewerTyping() async throws {
        try await MainActor.run {
            let draft = ComposerDraftBuffer(text: "first")
            let submission = try XCTUnwrap(draft.submission())

            draft.updateFromEditor("new text typed while sending")

            XCTAssertFalse(draft.clear(ifUnchangedSince: submission))
            XCTAssertEqual(draft.text, "new text typed while sending")
        }
    }

    func testRepositoryPrunesDeletedSessions() async {
        await MainActor.run {
            let repository = ComposerDraftRepository()
            let retained = repository.draft(for: "retained")
            repository.draft(for: "deleted").updateFromEditor("discard me")

            repository.retainDrafts(for: ["retained"])

            XCTAssertTrue(retained === repository.draft(for: "retained"))
            XCTAssertEqual(repository.draft(for: "deleted").text, "")
        }
    }
}
