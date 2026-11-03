import Foundation
import Observation
import CorptieClientCore

/// In-memory editing state owned by the resident settings page, never by a Provider.
/// Summaries change with edits, not with navigation, hover, scrolling, or chat tokens.
@MainActor @Observable
final class SettingsDraftState {
    struct Snapshot: Equatable {
        var dataRoot: String
        var choiceParser: ChoiceParserSettings
        var codexBackend: CodexBackendSettings
        var codeDiff: CodeDiffSettings
        var agentProxy: AgentProxySettings
        var gateway: GatewaySettings
        var taskCreation: TaskCreationDefaults

        init(_ settings: BackendSettings) {
            dataRoot = settings.dataRoot
            choiceParser = settings.choiceParser ?? .defaults
            codexBackend = settings.codexBackend ?? .defaults
            codeDiff = settings.codeDiff ?? .defaults
            agentProxy = settings.agentProxy ?? .defaults
            gateway = settings.gateway ?? .defaults
            taskCreation = settings.newSessionDefaults?.taskCreation ?? TaskCreationDefaults()
        }
    }

    var dataRoot = "" { didSet { updateSummary(.general) } }
    var choiceParser = ChoiceParserSettings.defaults { didSet { updateSummary(.provider) } }
    var codexBackend = CodexBackendSettings.defaults { didSet { updateSummary(.provider) } }
    var codeDiff = CodeDiffSettings.defaults { didSet { updateSummary(.general) } }
    var agentProxy = AgentProxySettings.defaults { didSet { updateSummary(.proxy) } }
    var gateway = GatewaySettings.defaults { didSet { updateSummary(.gateway) } }
    var taskCreation = TaskCreationDefaults() { didSet { updateSummary(.provider) } }
    private(set) var baseline: Snapshot?
    private(set) var dirtyTabs: Set<SettingsTab> = []
    private(set) var conflictTabs: Set<SettingsTab> = []
    private(set) var dataRootError: String?
    var showValidation = false
    var isSaving = false
    private(set) var isReadOnly = false
    var loadError: String?
    var saveError: String?
    var lastSavedAt: Date?
    @ObservationIgnored private var applyingSnapshot = false

    var isLoaded: Bool { baseline != nil }
    var canSave: Bool {
        isLoaded && !isReadOnly && !dirtyTabs.isEmpty && dataRootError == nil && conflictTabs.isEmpty && !isSaving
    }

    var snapshot: Snapshot? {
        guard var value = baseline else { return nil }
        value.dataRoot = dataRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        value.choiceParser = choiceParser
        value.codexBackend = codexBackend
        value.codeDiff = codeDiff
        value.agentProxy = agentProxy
        value.gateway = gateway
        value.taskCreation = taskCreation
        return value
    }

    /// Merge clean fields and preserve edited fields. No server CAS is assumed.
    func receive(_ settings: BackendSettings) {
        isReadOnly = settings.developmentPreview
        let remote = Snapshot(settings)
        guard let old = baseline, let local = snapshot else {
            baseline = remote
            apply(remote)
            loadError = nil
            return
        }
        var merged = remote
        func merge<Value: Equatable>(_ key: WritableKeyPath<Snapshot, Value>, tab: SettingsTab) {
            guard local[keyPath: key] != old[keyPath: key] else { return }
            merged[keyPath: key] = local[keyPath: key]
            if remote[keyPath: key] != old[keyPath: key], remote[keyPath: key] != local[keyPath: key] {
                conflictTabs.insert(tab)
            }
        }
        merge(\.dataRoot, tab: .general)
        merge(\.choiceParser, tab: .provider)
        merge(\.codexBackend, tab: .provider)
        merge(\.codeDiff, tab: .general)
        merge(\.agentProxy, tab: .proxy)
        merge(\.gateway, tab: .gateway)
        merge(\.taskCreation, tab: .provider)
        baseline = remote
        apply(merged)
        loadError = nil
    }

    func discard() {
        guard let baseline else { return }
        conflictTabs = []
        showValidation = false
        saveError = nil
        apply(baseline)
    }

    func saved(_ settings: BackendSettings) {
        baseline = Snapshot(settings)
        conflictTabs = []
        apply(Snapshot(settings))
        saveError = nil
        lastSavedAt = Date()
    }

    /// One in-flight snapshot. Failure leaves the draft intact; the caller can
    /// then reconcile a readback when the endpoint may have partially applied it.
    func save(using operation: @MainActor (Snapshot) async throws -> BackendSettings) async -> Bool {
        showValidation = true
        guard canSave, let submitted = snapshot else { return false }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            let settings = try await operation(submitted)
            saved(settings)
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    private func apply(_ value: Snapshot) {
        applyingSnapshot = true
        dataRoot = value.dataRoot
        choiceParser = value.choiceParser
        codexBackend = value.codexBackend
        codeDiff = value.codeDiff
        agentProxy = value.agentProxy
        gateway = value.gateway
        taskCreation = value.taskCreation
        applyingSnapshot = false
        updateSummary()
    }

    private func updateSummary(_ tab: SettingsTab? = nil) {
        guard !applyingSnapshot, let baseline else { return }
        var changed = dirtyTabs
        func set(_ category: SettingsTab, _ dirty: Bool) {
            if dirty { changed.insert(category) } else { changed.remove(category) }
        }
        if tab == nil || tab == .general {
            set(.general, dataRoot.trimmingCharacters(in: .whitespacesAndNewlines) != baseline.dataRoot || codeDiff != baseline.codeDiff)
            dataRootError = dataRoot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? L10n("Data root is required.") : nil
        }
        if tab == nil || tab == .provider {
            set(.provider, taskCreation != baseline.taskCreation || choiceParser != baseline.choiceParser || codexBackend != baseline.codexBackend)
        }
        if tab == nil || tab == .proxy { set(.proxy, agentProxy != baseline.agentProxy) }
        if tab == nil || tab == .gateway { set(.gateway, gateway != baseline.gateway) }
        dirtyTabs = changed
        conflictTabs.formIntersection(changed)
        // Match the existing settings API's required-value check. Filesystem and
        // migration preflight remain authoritative on the backend.
    }
}
