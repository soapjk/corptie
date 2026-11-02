import Foundation
import Testing
@testable import CorptieMac

struct ManagementOverviewTests {
    @Test func completedAndCancelledAutomationsStayReachableThroughHistory() {
        let records = [automation("active", status: .active), automation("failed", status: .error),
                       automation("completed", status: .completed), automation("cancelled", status: .cancelled)]
        #expect(AutomationOverviewPolicy.items(in: .all, from: records).map(\.id) == ["active", "failed"])
        #expect(AutomationOverviewPolicy.items(in: .history, from: records).map(\.id) == ["completed", "cancelled"])
        #expect(Set(AutomationOverviewPolicy.items(in: .all, from: records).map(\.id))
            .union(AutomationOverviewPolicy.items(in: .history, from: records).map(\.id)) == Set(records.map(\.id)))
    }

    @Test func runningAndFailedCategoriesUseAuthoritativeRunState() {
        let running = automation("running", status: .active, lastRun: .running)
        let failed = automation("retry", status: .active, lastRun: .failed)
        #expect(AutomationOverviewPolicy.items(in: .running, from: [failed, running]).map(\.id) == ["running"])
        #expect(AutomationOverviewPolicy.items(in: .failed, from: [failed, running]).map(\.id) == ["retry"])
    }

    @MainActor @Test func untrustedAndRevokedMemoriesCannotBePresentedAsActive() throws {
        let data = Data(#"{"id":"memory:a","ownerType":"task","ownerId":"task:a","kind":"fact","content":"A fact","sourceType":"extracted","promotionStatus":"candidate","trustLevel":"untrusted","createdAt":"2026-01-01T00:00:00Z"}"#.utf8)
        let memory = try JSONDecoder().decode(MemoryItem.self, from: data)
        #expect(MemoryPresentationLabels.recallState(memory) == L10n("待审核 · 尚未生效"))
        let revokedData = Data(String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\"promotionStatus\":\"candidate\"", with: "\"promotionStatus\":\"active\",\"revokedAt\":\"2026-02-01T00:00:00Z\"").utf8)
        let revoked = try JSONDecoder().decode(MemoryItem.self, from: revokedData)
        #expect(MemoryPresentationLabels.recallState(revoked) == L10n("未生效"))
    }

    private func automation(_ id: String, status: ScheduledSessionTaskStatus,
                            lastRun: ScheduledSessionRunStatus? = nil) -> ScheduledSessionTask {
        ScheduledSessionTask(taskId: id, logicalSessionId: "session:a", message: "Check state",
                             scheduleType: .interval, runAt: nil, nextRunAt: nil, intervalSeconds: 3600,
                             timezone: "Asia/Shanghai", status: status, missedPolicy: .coalesceOnce,
                             lastRunStatus: lastRun, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }
}
