import Testing
@testable import CorptieMac

struct ConsoleAttentionPolicyTests {
    @Test func situationTextIsBoundedAndMarksHistoricalJudgments() {
        #expect(TaskCardSituationText.compact("等待\n 用户确认", historical: false) == "等待 用户确认")
        #expect(TaskCardSituationText.compact("", historical: true) == "待确认 · 需要介入")
        #expect(TaskCardSituationText.compact(String(repeating: "文", count: 200), historical: false).count == 101)
    }
    @Test func readingDoesNotResolveAttention() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(unread: true, summary: .attention)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(summary: .attention)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(summary: .attention, deferred: true)))
    }
    @Test func staleAndUnknownPreserveAttentionButFreshResolutionClearsIt() {
        #expect(ConsoleAttentionPolicy.retainedDecision(current: nil, historical: "required", retained: nil, sameScope: true) == .required)
        #expect(ConsoleAttentionPolicy.retainedDecision(current: "unknown", historical: "unknown", retained: "attention", sameScope: true) == .attention)
        #expect(ConsoleAttentionPolicy.retainedDecision(current: "not_required", historical: "required", retained: nil, sameScope: true) == .notRequired)
        #expect(ConsoleAttentionPolicy.retainedDecision(current: nil, historical: "required", retained: nil, sameScope: false) == .unknown)
    }
    @Test func idleWithoutWorkIsHidden() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init()))
    }
    @Test func taskAwaitingItsFirstInstructionIsVisible() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(awaitingInitialInstruction: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(
            awaitingInitialInstruction: true, deferred: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(
            excluded: true, awaitingInitialInstruction: true)))
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
    @Test func unknownReadResultWithoutAttentionIsHidden() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(hasReply: true)))
    }
    @Test func unknownSummaryDoesNotHidePositiveAttentionSignals() {
        #expect(ConsoleAttentionPolicy.shouldShow(.init(selected: true, hasReply: true)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(running: true, hasReply: true)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(unread: true, hasReply: true)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(explicitAttention: true, hasReply: true)))
    }
    @Test func deferredIssueIsHiddenUntilItsReceiptChanges() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(unread: true, explicitAttention: true, deferred: true)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(unread: true, explicitAttention: true, deferred: false)))
    }
    @Test func deferralImmediatelyRemovesCurrentTask() {
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(selected: true, deferred: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(selected: false, deferred: true)))
        #expect(!ConsoleSelectionRefreshPolicy.permitsAutomaticDefaultSelection(
            selectedTaskID: nil, selectedSessionID: nil, explicitlyCleared: true))
    }
    @Test func deferralReturnsThroughExplicitClickHistory() {
        var history = TaskCardClickHistory()
        history.visit("a"); history.visit("b"); history.visit("c")
        #expect(history.dismiss("c", eligible: ["a", "b"]) == "b")
        #expect(history.dismiss("b", eligible: ["a"]) == "a")
        #expect(history.dismiss("a", eligible: []) == nil)
    }
    @Test func historySkipsUnavailableCardsAndDeduplicatesRepeatedClicks() {
        var history = TaskCardClickHistory()
        history.visit("a"); history.visit("b"); history.visit("b"); history.visit("c")
        #expect(history.ids == ["a", "b", "c"])
        #expect(history.dismiss("c", eligible: ["a"]) == "a")
        for index in 0..<1000 { history.visit(String(index)) }
        #expect(history.ids.count == 64)
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
