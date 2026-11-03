import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMac

@MainActor struct SettingsDraftStateTests {
    @Test func firstCollaborationConfirmationDefaultsOnAndParticipatesInSaveDiscardAndRefresh() async throws {
        let state = SettingsDraftState()
        state.receive(try settings())
        #expect(state.collaboration.requireFirstMessageConfirmation)
        state.collaboration.requireFirstMessageConfirmation = false
        #expect(state.dirtyTabs == [.general])
        state.receive(try settings(["codeDiff": ["tool": "vscode"]]))
        #expect(!state.collaboration.requireFirstMessageConfirmation)
        #expect(state.codeDiff.tool == "vscode")
        #expect(state.canSave)
        let success = await state.save { snapshot in
            #expect(!snapshot.collaboration.requireFirstMessageConfirmation)
            return try settings(["collaboration": ["requireFirstMessageConfirmation": false]])
        }
        #expect(success)
        #expect(state.dirtyTabs.isEmpty)
        state.collaboration.requireFirstMessageConfirmation = true
        state.discard()
        #expect(!state.collaboration.requireFirstMessageConfirmation)
        #expect(state.dirtyTabs.isEmpty)
        #expect(try settings(["collaboration": [:]]).collaboration?.requireFirstMessageConfirmation == true)
    }

    @Test func firstCollaborationConfirmationSerializesFalseAsBoolean() throws {
        let body = BackendSettingsAPI.updateBody(dataRoot: "/test", expectedSourceDataRoot: nil,
            choiceParser: nil, codexBackend: nil, codeDiff: nil, agentProxy: nil, gateway: nil,
            collaboration: .init(requireFirstMessageConfirmation: false))
        let collaboration = try #require(body["collaboration"] as? [String: Any])
        #expect(collaboration["requireFirstMessageConfirmation"] as? Bool == false)
        #expect(JSONSerialization.isValidJSONObject(body))
        let decoded = try settings(["collaboration": collaboration])
        #expect(decoded.collaboration?.requireFirstMessageConfirmation == false)
    }

    private func settings(_ extra: [String: Any] = [:]) throws -> BackendSettings {
        var value: [String: Any] = ["dataRoot": "/test/root"]
        value.merge(extra) { _, new in new }
        return try JSONDecoder().decode(BackendSettings.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func editsAcrossCategoriesRevertAndDiscardWithoutTouchingIndependentState() throws {
        let state = SettingsDraftState()
        state.receive(try settings())
        #expect(!state.canSave)
        state.codeDiff.tool = "vscode"
        state.agentProxy.codex.enabled = true
        state.taskCreation = .init(providerId: "neutral", model: "chosen")
        #expect(state.dirtyTabs == [.general, .proxy, .provider])
        state.codeDiff = .defaults
        #expect(state.dirtyTabs == [.proxy, .provider])
        state.discard()
        #expect(state.dirtyTabs.isEmpty)
        #expect(state.taskCreation == TaskCreationDefaults())
    }

    @Test func unrelatedRemoteFieldsMergeWhileEditedFieldsAndHiddenValuesSurvive() throws {
        let state = SettingsDraftState()
        state.receive(try settings(["codexBackend": ["mode": "pty"]]))
        state.codeDiff.tool = "vscode"
        state.receive(try settings(["codexBackend": ["mode": "pty"], "gateway": ["trustedWorkspaces": ["/remote"]]]))
        #expect(state.codeDiff.tool == "vscode")
        #expect(state.gateway.trustedWorkspaces == ["/remote"])
        #expect(state.codexBackend.mode == "pty")
        #expect(state.conflictTabs.isEmpty)
        #expect(state.dirtyTabs == [.general])
    }

    @Test func conflictPreservesInputAndPreventsOverwriteUntilExplicitDiscard() throws {
        let state = SettingsDraftState()
        state.receive(try settings())
        state.codeDiff.tool = "vscode"
        state.receive(try settings(["codeDiff": ["tool": "filemerge"]]))
        #expect(state.codeDiff.tool == "vscode")
        #expect(state.conflictTabs == [.general])
        #expect(!state.canSave)
        state.discard()
        #expect(state.codeDiff.tool == "filemerge")
        #expect(state.conflictTabs.isEmpty)
        #expect(state.dirtyTabs.isEmpty)
    }

    @Test func requiredValueAndPreviewPreventWritesWithoutPretendingDefaultsLoaded() async throws {
        let state = SettingsDraftState()
        #expect(!state.isLoaded)
        state.dataRoot = "/not-loaded"
        #expect(!state.canSave)
        state.receive(try settings())
        state.dataRoot = "  \n "
        #expect(state.dataRootError != nil)
        var calls = 0
        let result = await state.save { _ in calls += 1; return try settings() }
        #expect(!result)
        #expect(calls == 0)
        #expect(state.showValidation)
        state.discard()
        state.receive(try settings(["developmentPreview": true]))
        state.codeDiff.tool = "vscode"
        #expect(state.isReadOnly)
        #expect(!state.canSave)
    }

    @Test func failedSaveRetainsDraftAndReadbackClearsOnlyConfirmedFields() async throws {
        let state = SettingsDraftState()
        state.receive(try settings())
        state.dataRoot = "/target"
        state.codeDiff.tool = "vscode"
        let result = await state.save { _ in throw URLError(.notConnectedToInternet) }
        #expect(!result)
        #expect(state.lastSavedAt == nil)
        #expect(state.saveError != nil)
        state.receive(try settings(["codeDiff": ["tool": "vscode"]]))
        #expect(state.dataRoot == "/target")
        #expect(state.codeDiff.tool == "vscode")
        #expect(state.snapshot?.dataRoot == "/target")
        state.discard()
        #expect(state.dataRoot == "/test/root")
        #expect(state.codeDiff.tool == "vscode")
    }

    @Test func oneInflightSavePreservesSubmittedSnapshotAndConfirmsServerResult() async throws {
        let state = SettingsDraftState()
        state.receive(try settings())
        state.codeDiff.tool = "vscode"
        var calls = 0
        let first = Task { @MainActor in
            await state.save { submitted in
                calls += 1
                #expect(submitted.codeDiff.tool == "vscode")
                try await Task.sleep(for: .milliseconds(20))
                return try settings(["codeDiff": ["tool": "vscode"]])
            }
        }
        while !state.isSaving { await Task.yield() }
        let second = await state.save { _ in calls += 1; return try settings() }
        #expect(!second)
        #expect(await first.value)
        #expect(calls == 1)
        #expect(state.dirtyTabs.isEmpty)
        #expect(state.lastSavedAt != nil)
    }

    @Test func localTypingDoesNotReprocessLargeUnrelatedWorkspaceInventory() throws {
        let state = SettingsDraftState()
        state.receive(try settings(["gateway": ["trustedWorkspaces": (0..<10_000).map { "/test/\($0)" }]]))
        for index in 0..<1000 { state.dataRoot = "/typing/\(index)" }
        #expect(state.dirtyTabs == [.general])
        #expect(state.gateway.trustedWorkspaces.count == 10_000)
        #expect(state.conflictTabs.isEmpty)
    }

    @Test func independentAPIValidationAndSecretIntentStaySeparateFromSharedDiscard() throws {
        let shared = SettingsDraftState()
        shared.receive(try settings())
        let model = FoundationModelDraft(baseURL: URL(string: "http://test.invalid")!)
        model.loaded = true
        model.value.mode = "api"
        model.value.model = "test"
        for invalid in ["http://remote.invalid/v1", "https://user:secret@remote.invalid", "https://remote.invalid/?secret=value", "file:///tmp/model"] {
            model.value.baseURL = invalid
            #expect(model.validationError != nil)
        }
        for valid in ["https://remote.invalid/v1", "http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"] {
            model.value.baseURL = valid
            #expect(model.validationError == nil)
        }
        model.apiKey = "synthetic"
        model.clearKey = true
        #expect(model.apiKey.isEmpty)
        model.apiKey = "replacement"
        #expect(!model.clearKey)
        shared.discard()
        #expect(model.apiKey == "replacement")
        #expect(model.isDirty)
        model.discard()
        #expect(model.apiKey.isEmpty)
        #expect(!model.isDirty)
    }
}
