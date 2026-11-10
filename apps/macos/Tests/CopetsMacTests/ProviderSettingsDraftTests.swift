import Foundation
import Testing
@testable import CorptieMac

@MainActor struct ProviderSettingsDraftTests {
    private func status(source: String? = nil, enabled: Bool = true) throws -> FirstRunStatus {
        let selected: Any = source.map { ["kind": "directory", "path": $0] as Any } ?? NSNull()
        let row: [String: Any] = ["id": "test", "name": "Test", "path": "/tmp/engine", "enabled": enabled,
            "executable": true, "checkState": "unknown", "runtime": [
                "runtimeDirectory": "/tmp/runtime", "credentialTarget": "/tmp/runtime/auth.json",
                "reuseMethod": "synchronize", "sourceKinds": ["directory", "file"], "source": selected,
                "candidates": [["kind": "directory", "path": "/tmp/official", "state": "found"]],
                "state": source == nil ? "unselected" : "found", "message": "local", "sourceChanged": false]]
        return try JSONDecoder().decode(FirstRunStatus.self, from:
            JSONSerialization.data(withJSONObject: ["completed": true, "hasWorks": false, "providers": [row]]))
    }

    @Test func visibleDiscoveredSourceIsIncludedWhenTheWholePageIsSaved() async throws {
        let draft = ProviderSettingsDraft()
        draft.receive(try status())
        #expect(draft.isDirty)
        #expect(draft.values["test"]?.source?.path == "/tmp/official")
        var calls = 0
        try await draft.save { body in
            calls += 1
            #expect(body.count == 1)
            #expect((body[0]["source"] as? [String: String])?["path"] == "/tmp/official")
            #expect(body[0]["enabled"] as? Bool == true)
            return try status(source: "/tmp/official")
        }
        #expect(calls == 1)
        #expect(!draft.isDirty)
    }

    @Test func togglesAndSourceEditsArePendingUntilSaveAndFailureRetainsThem() async throws {
        let draft = ProviderSettingsDraft()
        draft.receive(try status(source: "/tmp/official"))
        draft.edit("test", path: "/tmp/other", enabled: false, source: .init(kind: "file", path: "/tmp/custom.json"))
        #expect(draft.baseline["test"]?.enabled == true)
        #expect(draft.values["test"]?.enabled == false)
        do {
            try await draft.save { _ in throw BackendError.message("local validation failed") }
            Issue.record("Expected save to fail")
        } catch { }
        #expect(draft.isDirty)
        #expect(draft.values["test"]?.path == "/tmp/other")
        draft.discard()
        #expect(!draft.isDirty)
        #expect(draft.values["test"]?.source?.path == "/tmp/official")
    }

    @Test func accountAndBinaryEditsAreSubmittedTogetherByTheSharedSave() async throws {
        // Onboarding now uses this same draft: switching the Codex account and
        // choosing a binary must never take two different submission paths.
        let draft = ProviderSettingsDraft()
        draft.receive(try status())
        draft.edit("test", path: "/tmp/custom-codex", enabled: true, accountId: "account-b")
        var submitted: [[String: Any]] = []
        try await draft.save { body in
            submitted = body
            return try status(source: "/tmp/official")
        }
        #expect(submitted.count == 1)
        #expect(submitted[0]["path"] as? String == "/tmp/custom-codex")
        #expect(submitted[0]["accountId"] as? String == "account-b")
        #expect(submitted[0]["enabled"] as? Bool == true)
    }

    @Test func savingDoesNotRebuildCardsMidAutomaticCheck() async throws {
        // An automatic check starts immediately after the save that applies
        // the selected account. Rebuilding the card here would cancel it.
        let draft = ProviderSettingsDraft()
        draft.receive(try status())
        draft.edit("test", accountId: "account-b")
        let generation = draft.refreshGeneration
        try await draft.save { _ in try status(source: "/tmp/official") }
        #expect(draft.refreshGeneration == generation)
        #expect(!draft.isDirty)
        draft.edit("test", enabled: false)
        draft.discard()
        #expect(draft.refreshGeneration == generation + 1)
    }

    @Test func providerChangesParticipateInTheSharedSaveButtonAndDiscard() throws {
        let shared = SettingsDraftState()
        shared.receive(try JSONDecoder().decode(BackendSettings.self, from: Data("{\"dataRoot\":\"/tmp/root\"}".utf8)))
        shared.providerDraft.receive(try status(source: "/tmp/official"))
        #expect(!shared.canSave)
        shared.providerDraft.edit("test", enabled: false)
        #expect(shared.canSave)
        #expect(shared.dirtyTabs.contains(.provider))
        shared.discard()
        #expect(!shared.canSave)
    }
}
