#if os(iOS)
import Foundation
import CorptieClientCore
import CorptieConversation

/// Platform data/command boundary only. All controls live in the shared package.
@MainActor struct PadDetailConfigurationAdapter {
    let store: PadInspectorStore
    let workspace: PadWorkspace
    let connection: PadConnection
    let sessionID: String
    private var locked: Bool { store.busy || store.pending != nil }
    var configuration: ClientDetailConfiguration {
        let currentProviderID = store.snapshot?.environment["provider"].text
        let providers = (store.sections["providers"] ?? .null).items
        let currentProviderName = providers.first { $0["id"].text == currentProviderID }?["name"].text
            ?? currentProviderID ?? "未知"
        let active = workspace.selection == sessionID && store.connected && store.snapshot?.sessionId == sessionID
        let config = active ? workspace.composerConfiguration : nil
        let modelID = config?.currentModel ?? ""
        let model = config?.models.first { $0.id == modelID }
        let level = config?.currentReasoningLevel ?? model?.defaultReasoningLevel ?? ""
        return ClientDetailConfiguration(
            provider: .init(id: currentProviderID ?? "", title: currentProviderName,
                choices: providers.compactMap { value in
                    guard let id = value["id"].text else { return nil }
                    return .init(id: id, title: value["name"].text ?? id, available: value["available"].flag)
                }, canSelect: active && !locked),
            model: .init(id: modelID, title: model?.name ?? modelID,
                choices: (config?.models ?? []).map { .init(id: $0.id, title: $0.name) }, canSelect: active && config?.switchModel.available == true),
            reasoning: .init(id: level, title: ComposerModelLabel.reasoningTitle(level),
                choices: (model?.reasoningLevels ?? []).map { .init(id: $0, title: ComposerModelLabel.reasoningTitle($0)) }, canSelect: active && config?.switchReasoning.available == true),
            busy: locked || workspace.configuringComposer, error: store.error)
    }
    func select(_ field: ClientDetailConfiguration.Field, _ id: String) async throws {
        guard workspace.selection == sessionID, store.connected, store.snapshot?.sessionId == sessionID, !locked else {
            throw ClientDetailConfigurationFailure.unavailable
        }
        let expectedProvider = store.snapshot?.environment["provider"].text
        switch field {
        case .provider:
            guard (store.sections["providers"] ?? .null).items.contains(where: { $0["id"].text == id && $0["available"].flag }) else { throw ClientDetailConfigurationFailure.unavailable }
            await store.command("provider.switch", fields: ["providerId": .string(id),
                "expectedRoutingVersion": store.snapshot?.environment["routingVersion"] ?? .null, "confirmed": .bool(true)], sessionID: sessionID, connection: connection)
            if let error = store.error { throw ClientDetailConfigurationFailure.unconfirmed(error) }
        case .model, .reasoning:
            let value = configuration.selection(field)
            guard value.canSelect, value.choices.contains(where: { $0.id == id && $0.available }) else { throw ClientDetailConfigurationFailure.unavailable }
            await workspace.configureComposer(connection, update: [field == .model ? "model" : "reasoningLevel": id])
            guard store.connected, store.snapshot?.sessionId == sessionID,
                  store.snapshot?.environment["provider"].text == expectedProvider, workspace.selection == sessionID else {
                throw ClientDetailConfigurationFailure.unconfirmed("会话绑定已变化，请核对当前配置；未重发操作")
            }
            let result = field == .model ? workspace.composerConfiguration?.currentModel : workspace.composerConfiguration?.currentReasoningLevel
            guard result == id else { throw ClientDetailConfigurationFailure.unconfirmed("配置更新尚未确认，请核对当前值；不要重复提交") }
        }
    }
    func reload() async {
        guard workspace.selection == sessionID, store.connected, store.snapshot?.sessionId == sessionID else { return }
        await workspace.configureComposer(connection)
    }
}

@MainActor struct PadDetailTurnAdapter {
    let store: PadInspectorStore
    let workspace: PadWorkspace
    let connection: PadConnection
    let sessionID: String
    private var session: ClientSession? { workspace.sessionsByID[sessionID] }
    var expectedSessionIDs: [String] { [sessionID, session?.logicalSessionId ?? "", store.snapshot?.resolvedSessionId ?? ""] }
    var snapshot: ClientTurnSummary? {
        guard store.snapshot?.sessionId == sessionID, store.snapshot?.errors["turn"] == nil else { return nil }
        return ClientTurnSummary(inspectorValue: store.sections["turn"] ?? .null, expectedSessionIDs: expectedSessionIDs)
    }
    func summary(_ execution: String) async throws -> ClientTurnSummary {
        guard store.connected, let value = snapshot, value.turnExecutionId == execution else { throw ClientDetailFailure.invalidGraph }
        return value
    }
    func trace(_ execution: String, _ cursor: String?) async throws -> ClientTurnTrace {
        guard store.connected, store.snapshot?.sessionId == sessionID else { throw ClientDetailConfigurationFailure.unavailable }
        let owner = connection.businessDisplayScope(sessionID: sessionID, taskID: session?.taskId, workID: session?.workId)
        let provider = store.snapshot?.environment["provider"].text
        var parameters: [String: ClientInspectorValue] = ["id": .string(execution)]
        if let cursor { parameters["cursor"] = .string(cursor) }
        let value = try await ClientInspectorAPI(transport: connection.transport()).read(sessionID: sessionID, resource: "trace", parameters: parameters)
        guard store.connected, store.snapshot?.sessionId == sessionID, store.snapshot?.environment["provider"].text == provider,
              connection.businessDisplayScope(sessionID: sessionID, taskID: session?.taskId, workID: session?.workId) == owner else { throw ClientDetailConfigurationFailure.unavailable }
        return try ClientTurnTrace(inspectorValue: value)
    }
}
#endif

