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
