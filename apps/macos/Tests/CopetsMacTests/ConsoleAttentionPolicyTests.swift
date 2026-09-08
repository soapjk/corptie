import Testing
@testable import CorptieMac

struct ConsoleAttentionPolicyTests {
    @Test func idleWithoutWorkIsHidden() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init()))
    }
    @Test func runningIsVisibleEvenWhenDeferred() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(running: true, deferred: true)))
    }
    @Test func unreadResultIsVisibleEvenWhenNoActionIsRequired() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(unread: true, summary: .notRequired)))
    }
    @Test func readDoesNotResolveExplicitAttention() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(explicitAttention: true, summary: .notRequired)))
    }
    @Test func readDoesNotResolveSemanticAttention() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(hasReply: true, summary: .required)))
    }
    @Test func readResultWithoutActionIsHidden() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(hasReply: true, summary: .notRequired)))
    }
    @Test func unknownReadResultIsConservativelyRetained() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(hasReply: true)))
    }
    @Test func deferredIssueIsHiddenUntilItsReceiptChanges() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(unread: true, explicitAttention: true, deferred: true)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(unread: true, explicitAttention: true, deferred: false)))
    }
    @Test func currentTaskRemainsUntilUserSwitches() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(selected: true, deferred: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(selected: false, deferred: true)))
    }
    @Test func cancelledOrScheduledWorkIsNotInventedAttention() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(hasReply: true, cancelled: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(hasReply: true, scheduled: true)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(unread: true, cancelled: true)))
    }
    @Test func archivedAndDeletingNeverReturn() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(excluded: true, selected: true, running: true, unread: true)))
    }
}
