import Combine
import Foundation
import Testing

@testable import CorptieMac

@MainActor
struct RoleRegistryPresentationTests {
    @Test("Committed terms match across fields with stable order and Unicode normalization")
    func search() {
        let items = [
            ["name": "Café 工程师", "description": "Swift UI", "specialty": "性能优化"],
            ["name": "Other", "description": "swift API", "specialty": "backend"],
        ]
        let index = RegistrySearchIndex(items: items) {
            [$0["name"]!, $0["description"]!, $0["specialty"]!]
        }
        #expect(index.matches("  SWIFT\n性能 ") == [items[0]])
        #expect(index.matches("Cafe\u{301}") == [items[0]])
        #expect(index.matches("SWIFT") == items)
        #expect(index.matches(" \t\n") == items)
        #expect(index.matches("Swift 不存在").isEmpty)
    }

    @Test("Empty responses and failures remain distinct, cached content survives failure")
    func loadPhases() {
        #expect(RegistryLoadPhase(itemCount: 0, hasLoaded: false, error: nil) == .loading)
        #expect(RegistryLoadPhase(itemCount: 0, hasLoaded: false, error: "offline") == .failed)
        #expect(RegistryLoadPhase(itemCount: 0, hasLoaded: true, error: nil) == .empty)
        #expect(RegistryLoadPhase(itemCount: 0, hasLoaded: true, error: "offline") == .failed)
        #expect(RegistryLoadPhase(itemCount: 1, hasLoaded: true, error: "offline") == .content)
    }

    @Test("Session updates do not publish registry changes or lose role and Skill queries")
    func scopedObservation() {
        let store = AppStateStore()
        let model = RoleRegistryPresentation(store: store)
        let role = role()
        let skill = Skill(
            skillId: "skill:one", name: "Skill", description: "Shared description",
            sourceType: "local",
            source: "/private/source", installedAt: "2026-11-01", updatedAt: "2026-11-01")
        func payload(_ sessions: [TaskSession]) -> ControlPlaneStatePayload {
            .init(
                sessions: sessions, tasks: [], works: [], roles: [role], skills: [skill],
                repositories: [],
                integrationRuns: [])
        }
        store.apply(snapshot: .init(revision: 1, state: payload([])))
        #expect(model.matchingRoles("engineer").map(\.id) == [role.id])
        #expect(model.matchingRoles("secret-only").isEmpty)
        #expect(model.matchingSkills("description").map(\.id) == [skill.id])
        #expect(model.matchingSkills("/private/source").isEmpty)
        var publications = 0
        let subscription = model.objectWillChange.sink { publications += 1 }
        store.apply(snapshot: .init(revision: 2, state: payload([session()])))
        #expect(publications == 0)
        #expect(model.roles == [role])
        #expect(model.skills == [skill])
        withExtendedLifetime(subscription) {}
    }

    @Test("An updated role replaces its search entry and a deleted role cannot be found")
    func searchIndexFollowsState() {
        let store = AppStateStore()
        let model = RoleRegistryPresentation(store: store)
        var edited = role()
        func payload(_ roles: [Role]) -> ControlPlaneStatePayload {
            .init(
                sessions: [], tasks: [], works: [], roles: roles, skills: [], repositories: [],
                integrationRuns: [])
        }
        store.apply(snapshot: .init(revision: 1, state: payload([edited])))
        #expect(model.matchingRoles("engineer").count == 1)
        edited.name = "Designer"
        store.apply(snapshot: .init(revision: 2, state: payload([edited])))
        #expect(model.matchingRoles("engineer").isEmpty)
        #expect(model.matchingRoles("designer").count == 1)
        store.apply(snapshot: .init(revision: 3, state: payload([])))
        #expect(model.matchingRoles("designer").isEmpty)
        #expect(model.phase(itemCount: 0) == .empty)
    }

    @Test("A thousand-entry registry filters accurately without changing order")
    func largeRegistrySearch() {
        let items = (0..<1000).map { ["role-\($0)-end", "Swift UI 性能优化"] }
        let index = RegistrySearchIndex(items: items) { $0 }
        var timings: [Double] = []
        for number in 0..<30 {
            let start = ContinuousClock.now
            let matches = index.matches("SWIFT role-\(number)-end")
            let elapsed = start.duration(to: .now).components
            timings.append(Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15)
            #expect(matches == [items[number]])
        }
        #expect(index.matches("SWIFT") == items)
        let sorted = timings.sorted()
        print(
            "Registry search microbenchmark: 1000 entries, 30 samples, P95 \(sorted[28]) ms (filter only, not UI latency)"
        )
    }

    private func session() -> TaskSession {
        TaskSession(
            id: "session:one", title: "Changed chat", agent: "Test", roleId: nil,
            sessionKind: .worker,
            workId: nil, taskId: nil, status: .running, progress: 0, summary: "",
            suggestedOptions: nil,
            suggestedPrompt: nil, activityStatus: nil, updatedAt: "2026-11-01", accent: .cyan,
            archived: false, pinned: false, sortOrder: 0, capabilities: nil, external: nil,
            actions: nil)
    }

    private func role() -> Role {
        Role(
            roleId: "role:one", name: "Engineer", description: "Swift", status: "available",
            systemPrompt: "secret-only",
            capabilities: ["UI"], createdAt: "2026-11-01", updatedAt: "2026-11-01")
    }
}
