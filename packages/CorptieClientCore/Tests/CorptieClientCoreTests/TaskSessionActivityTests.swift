import Testing
@testable import CorptieClientCore

struct TaskSessionActivityTests {
    @Test func executionMappingAndBindingAreIndependentOfTaskLifecycle() {
        for (raw, expected) in [("running", TaskSessionActivity.processing), ("blocked", .waitingForInput),
            ("completed", .idle), ("cancelled", .interrupted), ("failed", .failed), ("paused", .paused)] {
            #expect(TaskSessionActivity.resolve(hasBinding: true, sessionExecutionStatus: raw,
                taskExecutionStatus: "running") == expected)
            #expect(TaskSessionActivity.resolve(hasBinding: true, sessionExecutionStatus: nil,
                taskExecutionStatus: raw) == expected)
        }
        #expect(TaskSessionActivity.resolve(hasBinding: false, sessionExecutionStatus: nil,
            taskExecutionStatus: "running") == .noSession)
        #expect(TaskSessionActivity.resolve(hasBinding: true, sessionExecutionStatus: "new-state",
            taskExecutionStatus: "running") == .unknown)
        #expect(TaskSessionActivity.resolve(hasBinding: true, sessionExecutionStatus: " INTERRUPTED ",
            taskExecutionStatus: nil) == .interrupted)
    }

    @Test func indicatorUsesDesktopColorsAndDoesNotLetLifecycleOverrideKnownExecution() {
        #expect(TaskSessionActivity.idle.indicatorTone(lifecycleState: "failed") == .orange)
        #expect(TaskSessionActivity.failed.indicatorTone(lifecycleState: "active") == .red)
        #expect(TaskSessionActivity.interrupted.indicatorTone() == .red)
        #expect(TaskSessionActivity.processing.indicatorTone() == .connected)
        #expect(TaskSessionActivity.paused.indicatorTone() == .orange)
        #expect(TaskSessionActivity.noSession.indicatorTone(lifecycleState: "complete") == .green)
        #expect(TaskSessionActivity.unknown.indicatorTone(lifecycleState: "active") == .connected)
        #expect(TaskSessionActivity.noSession.indicatorTone() == .secondary)
    }
}
