import Foundation
import Testing
@testable import CorptieConversation

struct WorkOutlinePolicyTests {
    @Test func expansionDefaultsAndMigrationAreShared() throws {
        let suite = "WorkOutlinePolicyTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WorkOutlineExpansionStore(defaults: defaults)
        #expect(store.load().isEmpty)
        #expect(!store.loadChat())
        defaults.set(["work:old"], forKey: "corptie.mobile.expandedWorkIDs.v1")
        #expect(store.load() == ["work:old"])
        store.save(["work:b", "work:a"])
        store.saveChat(true)
        let recreated = WorkOutlineExpansionStore(defaults: defaults)
        #expect(recreated.load() == ["work:a", "work:b"])
        #expect(!recreated.load().contains("work:new"))
        #expect(recreated.loadChat())
        recreated.save([])
        recreated.saveChat(false)
        #expect(store.load().isEmpty) // Never resurrect migrated entries.
        #expect(!store.loadChat())
    }

    @Test func sortAppliesToWorksTasksAndChatsWithStableTies() {
        struct Item { let id: String; let name: String; let updated: String; let message: String? }
        let items = [Item(id: "b", name: "B", updated: "2026-10-02", message: nil),
                     Item(id: "a", name: "A", updated: "2026-10-02", message: nil),
                     Item(id: "c", name: "C", updated: "2026-10-01", message: "2026-10-03")]
        func ordered(_ mode: WorkOutlineSort, activity: Bool = false) -> [String] {
            mode.ordered(items, id: { $0.id }, title: { $0.name }, updatedAt: { $0.updated },
                         activityAt: { $0.message }, prioritizesActivity: activity).map(\.id)
        }
        #expect(ordered(.standard) == ["b", "a", "c"])
        #expect(ordered(.name) == ["a", "b", "c"])
        #expect(ordered(.updated) == ["c", "a", "b"])
        #expect(ordered(.updated, activity: true) == ["c", "a", "b"])
    }
}
