import Foundation
import Testing
@testable import CorptieMac

struct TaskFixedDisplayTests {
    @Test func fixedTaskSurvivesReadResolvedAndUnknownAttention() {
        for summary in [ConsoleAttentionPolicy.Summary.notRequired, .unknown, .required] {
            #expect(ConsoleAttentionPolicy.shouldShow(.init(summary: summary, fixedDisplay: true)))
        }
        #expect(ConsoleAttentionPolicy.shouldShow(.init(deferred: true, fixedDisplay: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(excluded: true, fixedDisplay: true)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(summary: .notRequired, fixedDisplay: false)))
        #expect(!ConsoleAttentionPolicy.shouldShow(.init(deferred: true, fixedDisplay: false)))
        #expect(ConsoleAttentionPolicy.shouldShow(.init(running: true, fixedDisplay: false)))
    }

    @Test @MainActor func preferenceSurvivesRecreationAndUnfixingWithoutChangingOtherTasks() throws {
        let suite = "TaskFixedDisplayTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = TaskCardDisplayPreferences(defaults: defaults)
        #expect(preferences.taskIDs.isEmpty)
        preferences.setFixed(true, taskID: "task:a")
        preferences.setFixed(true, taskID: "task:b")
        preferences.setFixed(true, taskID: "task:a")
        let restored = TaskCardDisplayPreferences(defaults: defaults)
        #expect(restored.taskIDs == ["task:a", "task:b"])
        restored.setFixed(false, taskID: "task:a")
        #expect(TaskCardDisplayPreferences(defaults: defaults).taskIDs == ["task:b"])
    }
}
