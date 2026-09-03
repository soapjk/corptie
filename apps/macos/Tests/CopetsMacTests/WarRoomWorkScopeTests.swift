import Testing
@testable import CorptieMac

struct WarRoomWorkScopeTests {
    @Test func defaultsToAllWhenThereIsNoSavedWork() {
        #expect(WarRoomWorkScope.restoredSelection(
            savedId: nil,
            works: [work(id: "work:one")]
        ) == WarRoomWorkScope.allSelectionId)
    }

    @Test func restoresAllOrAnExistingWorkButNotADeletedWork() {
        let works = [work(id: "work:one")]
        #expect(WarRoomWorkScope.restoredSelection(
            savedId: WarRoomWorkScope.allSelectionId,
            works: works
        ) == WarRoomWorkScope.allSelectionId)
        #expect(WarRoomWorkScope.restoredSelection(
            savedId: "work:one",
            works: works
        ) == "work:one")
        #expect(WarRoomWorkScope.restoredSelection(
            savedId: "work:deleted",
            works: works
        ) == WarRoomWorkScope.allSelectionId)
    }
}

private func work(id: String) -> Work {
    Work(
        id: id,
        workspaceId: "workspace:\(id)",
        name: id,
        description: "",
        status: "active",
        profile: "general",
        tags: [],
        contributorAgentIds: [],
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z"
    )
}
