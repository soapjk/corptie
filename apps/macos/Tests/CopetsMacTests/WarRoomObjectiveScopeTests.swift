import Testing
@testable import CorptieMac

struct WarRoomObjectiveScopeTests {
    @Test func defaultsToAllWhenThereIsNoSavedObjective() {
        #expect(WarRoomObjectiveScope.restoredSelection(
            savedId: nil,
            objectives: [objective(id: "objective:one")]
        ) == WarRoomObjectiveScope.allSelectionId)
    }

    @Test func restoresAllOrAnExistingObjectiveButNotADeletedObjective() {
        let objectives = [objective(id: "objective:one")]
        #expect(WarRoomObjectiveScope.restoredSelection(
            savedId: WarRoomObjectiveScope.allSelectionId,
            objectives: objectives
        ) == WarRoomObjectiveScope.allSelectionId)
        #expect(WarRoomObjectiveScope.restoredSelection(
            savedId: "objective:one",
            objectives: objectives
        ) == "objective:one")
        #expect(WarRoomObjectiveScope.restoredSelection(
            savedId: "objective:deleted",
            objectives: objectives
        ) == WarRoomObjectiveScope.allSelectionId)
    }
}

private func objective(id: String) -> Objective {
    Objective(
        id: id,
        name: id,
        description: "",
        idealState: "",
        status: "active",
        priority: nil,
        targetDate: nil,
        tags: [],
        workspaceIds: [],
        relatedObjectiveIds: [],
        contributorAgentIds: [],
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z"
    )
}
