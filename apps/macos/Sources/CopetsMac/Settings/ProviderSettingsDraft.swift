import Foundation
import Observation

struct ProviderConfigurationDraft: Equatable {
    var path: String
    var enabled: Bool
    var source: ProviderCredentialSource?
    var accountId: String?
    var confirmSource = false

    init(_ provider: FirstRunProvider) {
        path = provider.program?.adoptedPath.nonEmpty ?? provider.path
        enabled = provider.enabled
        accountId = provider.accounts?.selectedAccountId
        source = provider.runtime?.source.map { .init(kind: $0.kind, path: $0.path) }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// Resident form state. Editing never sends a Provider operation or a model request.
@MainActor @Observable
final class ProviderSettingsDraft {
    private(set) var providers: [FirstRunProvider] = []
    private(set) var values: [String: ProviderConfigurationDraft] = [:]
    private(set) var baseline: [String: ProviderConfigurationDraft] = [:]
    private(set) var conflicts: Set<String> = []
    var loadError: String?
    var isLoading = false
    var isSaving = false
    var isLoaded = false
    var refreshGeneration = 0

    var dirtyIDs: Set<String> { Set(values.keys.filter { values[$0] != baseline[$0] }) }
    var isDirty: Bool { !dirtyIDs.isEmpty }

    func receive(_ status: FirstRunStatus) {
        providers = status.providers
        for provider in providers {
            let remote = ProviderConfigurationDraft(provider)
            let old = baseline[provider.id]
            let local = values[provider.id]
            if let old, let local, local != old {
                if remote != old && remote != local { conflicts.insert(provider.id) }
                baseline[provider.id] = remote
                if remote == local { values[provider.id] = remote; conflicts.remove(provider.id) }
            } else {
                baseline[provider.id] = remote
                values[provider.id] = remote
                stageDiscoveredSource(provider)
            }
        }
        isLoaded = true
        loadError = nil
    }

    private func stageDiscoveredSource(_ provider: FirstRunProvider) {
        guard values[provider.id]?.enabled == true else { return }
        if values[provider.id]?.source == nil,
           let candidate = provider.runtime?.candidates.first(where: { $0.state == "found" }) {
            values[provider.id]?.source = .init(kind: candidate.kind, path: candidate.path)
        }
        if provider.runtime?.state == "account_changed" {
            values[provider.id]?.confirmSource = true
        }
    }

    func edit(_ id: String, path: String? = nil, enabled: Bool? = nil, source: ProviderCredentialSource? = nil, accountId: String? = nil) {
        guard var value = values[id] else { return }
        if let accountId { value.accountId = accountId }
        if let path { value.path = path }
        if let enabled { value.enabled = enabled }
        if let source { value.source = .init(kind: source.kind, path: source.path); value.confirmSource = true }
        values[id] = value
        if enabled == true, let provider = providers.first(where: { $0.id == id }) { stageDiscoveredSource(provider) }
    }

    func discard() {
        values = baseline
        conflicts = []
        refreshGeneration += 1
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do { receive(try await FirstRunSetupAPI.request("first-run")) }
        catch { loadError = error.localizedDescription }
    }

    func save(using operation: (@MainActor ([[String: Any]]) async throws -> FirstRunStatus)? = nil) async throws {
        guard isDirty else { return }
        guard conflicts.isEmpty else { throw BackendError.message(L10n("执行引擎设置已在其他位置更改，请重新加载或放弃本地修改。")) }
        let submitted = values
        let body: [[String: Any]] = dirtyIDs.sorted().compactMap { id in
            guard let value = submitted[id] else { return nil }
            let source: Any = value.source.map { ["kind": $0.kind, "path": $0.path] as Any } ?? NSNull()
            return ["providerId": id, "path": value.path, "enabled": value.enabled,
                    "source": source, "accountId": value.accountId as Any? ?? NSNull(),
                    "confirmSource": value.confirmSource]
        }
        isSaving = true
        defer { isSaving = false }
        let status: FirstRunStatus
        if let operation { status = try await operation(body) }
        else { status = try await FirstRunSetupAPI.request("first-run/settings", body: ["providers": body]) }
        providers = status.providers
        for provider in status.providers {
            let saved = ProviderConfigurationDraft(provider)
            baseline[provider.id] = saved
            if values[provider.id] == submitted[provider.id] { values[provider.id] = saved }
        }
        conflicts = []
        refreshGeneration += 1
    }
}
