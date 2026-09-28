import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct NewPtyAgentTaskSheet: View {
    @ObservedObject private var modelCatalog: ProviderCatalogStore
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var sessionCreationState = BackendClient.shared.sessionCreationController
    @ObservedObject private var settingsState = BackendClient.shared.settingsController
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    @AppStorage("newTask.defaultSandboxMode", store: CorptieAppEnvironment.userDefaults) private var defaultSandboxMode = "workspace-write"
    @AppStorage("newTask.defaultApprovalPolicy", store: CorptieAppEnvironment.userDefaults) private var defaultApprovalPolicy = "on-request"
    @AppStorage("newTask.defaultCodexModel", store: CorptieAppEnvironment.userDefaults) private var defaultCodexModel = ""
    @AppStorage("newTask.defaultCodexReasoningLevel", store: CorptieAppEnvironment.userDefaults) private var defaultCodexReasoningLevel = ""
    @AppStorage("newTask.defaultClaudeModel", store: CorptieAppEnvironment.userDefaults) private var defaultClaudeModel = ""
    @State private var title = ""
    @State private var selectedProviderId = ""
    @State private var existingSessionId = ""
    @State private var cwd = ""
    @State private var sandboxMode = "workspace-write"
    @State private var approvalPolicy = "on-request"
    @State private var selectedModelId = ""
    @State private var selectedReasoningLevel = ""
    @State private var defaultSaveMessage: String?
    @State private var sessionLookupTask: Task<Void, Never>?
    @State private var isLookingUpSession = false
    @State private var sessionLookupMessage: String?
    @State private var isShowingAdvanced = false
    @State private var suggestedSessionTitle: String?
    let close: () -> Void

    init(initialWorkspacePath: String? = nil, modelCatalog: ProviderCatalogStore, close: @escaping () -> Void) {
        _modelCatalog = ObservedObject(wrappedValue: modelCatalog)
        _cwd = State(initialValue: initialWorkspacePath ?? "")
        self.close = close
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L10n("New Agent Task"))
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                Button {
                    close()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(IconButtonStyle())
                .help(L10n("Close"))
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Title"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                TextField(defaultSessionTitle, text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                    )
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Workspace"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                HStack(spacing: 8) {
                    TextField(backendClient.defaultWorkspacePath, text: $cwd)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .lineLimit(1)
                        .disabled(isBindingExistingSession)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(isBindingExistingSession ? 0.06 : 0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Color.white.opacity(isBindingExistingSession ? 0.08 : 0.14), lineWidth: 1)
                        )
                        .foregroundStyle(isBindingExistingSession ? CorptiePalette.mutedText : CorptiePalette.primaryText)

                    Button {
                        chooseWorkspace()
                    } label: {
                        Image(systemName: "folder")
                            .font(.system(size: 12, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(IconButtonStyle())
                    .disabled(isBindingExistingSession)
                    .opacity(isBindingExistingSession ? 0.45 : 1)
                    .help(L10n("Choose workspace folder"))
                }
                if isBindingExistingSession {
                    HStack(spacing: 6) {
                        if isLookingUpSession {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(sessionLookupMessage ?? L10n("Workspace is locked to the bound Codex session."))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(sessionLookupMessage?.hasPrefix("Session not found") == true ? .red : CorptiePalette.secondaryText)
                            .lineLimit(2)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Agent"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                HStack(spacing: 8) {
                    ForEach(creatableProviders) { provider in
                        PresetButton(
                            title: provider.displayName,
                            command: provider.id,
                            arguments: "",
                            isSelected: selectedProviderId == provider.id,
                            isDisabled: backendClient.isCreatingTask
                        ) { _ in
                            selectedProviderId = provider.id
                        }
                    }
                    if creatableProviders.isEmpty {
                        ProgressView().controlSize(.small)
                    }
                }
            }

            Button {
                withAnimation(.easeInOut(duration: 0.16)) {
                    isShowingAdvanced.toggle()
                }
            } label: {
                Label(isShowingAdvanced ? L10n("Hide Advanced Settings") : L10n("Advanced Settings"), systemImage: "slider.horizontal.3")
                    .font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.secondaryText)
            .help(isShowingAdvanced ? L10n("Hide advanced settings") : L10n("Show advanced settings"))

            if isShowingAdvanced {
                VStack(alignment: .leading, spacing: 12) {
                    modelPicker
                    reasoningPicker

                    if selectedProviderId == "codex-app-server" {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(L10n("Session ID"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            TextField(L10n("Bind existing Codex session"), text: $existingSessionId)
                                .textFieldStyle(.plain)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                                )
                                .help(L10n("Enter an existing Codex session id to resume it in Corptie"))
                                .onChange(of: existingSessionId) { _, value in
                                    scheduleSessionLookup(value)
                                }
                        }
                    }

                    if supportsPermissionConfiguration {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(L10n("Permission"))
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(Color.black)
                                Picker(L10n(""), selection: $sandboxMode) {
                                    Text(L10n("Workspace Write")).tag("workspace-write")
                                    Text(L10n("Full Access")).tag("danger-full-access")
                                    Text(L10n("Read Only")).tag("read-only")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .help(L10n("Controls the Agent filesystem sandbox mode"))
                            }

                            VStack(alignment: .leading, spacing: 7) {
                                Text(L10n("Approvals"))
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(Color.black)
                                Picker(L10n(""), selection: $approvalPolicy) {
                                    Text(L10n("Ask")).tag("on-request")
                                    Text(L10n("Ask for Risky Actions")).tag("ask-risky")
                                    Text(L10n("Never Ask")).tag("never")
                                    Text(L10n("On Failure")).tag("on-failure")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .help(L10n("Controls when the Agent asks before running privileged actions"))
                            }
                        }
                        if sandboxMode == "danger-full-access" {
                            Label(L10n("Full Access lets the Agent operate outside the workspace. Use it only for trusted tasks."), systemImage: "exclamationmark.triangle")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(CorptiePalette.amber)
                        }
                    }
                    if selectedProvider?.runtime.lifecycle == "managed" {
                        HStack(spacing: 8) {
                        Button {
                            saveNewSessionDefaults()
                        } label: {
                            Label(L10n("Set as Future Default"), systemImage: "checkmark.seal")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(CorptiePalette.softBlue)
                        .help(L10n("Use the selected model, reasoning, permission, and approval settings for future new sessions"))

                        if let defaultSaveMessage {
                            Text(defaultSaveMessage)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .transition(.opacity)
                        }
                        }
                    }

                }
            }

            HStack {
                if let message = backendClient.sendStatusMessage, message.hasPrefix("Create failed") {
                    Text(message)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }

                Spacer()

                Button {
                    startSelectedAgent()
                } label: {
                    if backendClient.isCreatingTask {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 30, height: 30)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                }
                .buttonStyle(IconButtonStyle())
                .disabled(isCreateDisabled)
                .help(L10n("Create task"))
            }
        }
        .padding(18)
        .frame(maxWidth: 380)
        .background(SheetPanelBackground(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .compositingGroup()
        .alert(
            L10n("A session with this name already exists."),
            isPresented: Binding(
                get: { suggestedSessionTitle != nil },
                set: { if !$0 { suggestedSessionTitle = nil } }
            )
        ) {
            if let suggestedSessionTitle {
                Button(L10nFormat("Create as “%@”", suggestedSessionTitle)) {
                    title = suggestedSessionTitle
                    self.suggestedSessionTitle = nil
                    startSelectedAgent(titleOverride: suggestedSessionTitle)
                }
            }
            Button(L10n("Cancel"), role: .cancel) {
                suggestedSessionTitle = nil
            }
        } message: {
            if let suggestedSessionTitle {
                Text(L10nFormat("Create the new session with the available name “%@”?", suggestedSessionTitle))
            }
        }
        .onAppear {
            if cwd.isEmpty {
                cwd = backendClient.defaultWorkspacePath
            }
            sandboxMode = validatedSandboxMode(defaultSandboxMode)
            approvalPolicy = validatedApprovalPolicy(defaultApprovalPolicy)
            Task {
                if modelCatalog.agentProviders.isEmpty {
                    await backendClient.loadProviders()
                }
                reconcileProviderSelection()
                loadModelsForCurrentAgent()
            }
        }
        .onDisappear {
            sessionLookupTask?.cancel()
        }
        .onChange(of: selectedProviderId) { _, _ in
            selectedModelId = ""
            selectedReasoningLevel = ""
            loadModelsForCurrentAgent()
        }
        .onChange(of: modelCatalog.agentProviders) { _, providers in
            reconcileProviderSelection()
            loadModelsForCurrentAgent()
        }
        .onChange(of: modelCatalog.defaultSessionProviderId) { _, _ in
            reconcileProviderSelection()
        }
        .onChange(of: modelCatalog.codexDefaultModel) { _, value in
            applyDefaultModelIfNeeded(value)
        }
        .onChange(of: modelCatalog.codexModels) { _, _ in
            applyDefaultModelIfNeeded(modelCatalog.codexDefaultModel)
        }
        .onChange(of: modelCatalog.codexDefaultReasoningLevel) { _, _ in
            applyDefaultReasoningIfNeeded()
        }
        .onChange(of: selectedModelId) { _, _ in
            applyDefaultReasoningIfNeeded(preferCurrentSelection: true)
        }
    }

    @ViewBuilder
    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(L10n("Model"))
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.black)

            if !supportsModelSelection {
                Text(L10n("Default"))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
                    )
            } else if modelCatalog.isLoadingCodexModels && modelCatalog.codexModels.isEmpty {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(L10n("Loading models"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                Picker(L10n(""), selection: $selectedModelId) {
                    if !selectedModelId.isEmpty,
                       !modelCatalog.codexModels.contains(where: { $0.id == selectedModelId }) {
                        Text(selectedModelId).tag(selectedModelId)
                    }
                    ForEach(modelCatalog.codexModels) { model in
                        Text(model.name).tag(model.id)
                    }
                    if selectedModelId.isEmpty && modelCatalog.codexModels.isEmpty {
                        Text(L10n("No models available")).tag("")
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(L10n("Choose the model for this new session"))
            }
        }
    }

    @ViewBuilder
    private var reasoningPicker: some View {
        if supportsReasoningSelection {
            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Reasoning"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)

                Picker(L10n(""), selection: $selectedReasoningLevel) {
                    if !selectedReasoningLevel.isEmpty,
                       !currentReasoningLevels.contains(selectedReasoningLevel) {
                        Text(newSessionReasoningLabel(selectedReasoningLevel))
                            .tag(selectedReasoningLevel)
                    }
                    ForEach(currentReasoningLevels, id: \.self) { reasoningLevel in
                        Text(newSessionReasoningLabel(reasoningLevel))
                            .tag(reasoningLevel)
                    }
                    if selectedReasoningLevel.isEmpty && currentReasoningLevels.isEmpty {
                        Text(L10n("No reasoning options")).tag("")
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(L10n("Choose the reasoning strength for this new session"))
            }
        }
    }

    private var supportsModelSelection: Bool {
        selectedProvider?.supports("configuration.model.list") == true
    }

    private var supportsReasoningSelection: Bool {
        selectedProvider?.supports("configuration.reasoning.switch") == true
    }

    private var supportsPermissionConfiguration: Bool {
        selectedProvider?.supports("configuration.permissions.update") == true
    }

    private var modelProviderForCurrentAgent: String {
        selectedProviderId
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        modelCatalog.agentProviders.filter { $0.supports("session.create") }
    }

    private var selectedProvider: AgentProviderDescriptor? {
        modelCatalog.agentProviders.first(where: { $0.id == selectedProviderId })
    }

    private func reconcileProviderSelection() {
        guard !creatableProviders.contains(where: { $0.id == selectedProviderId }) else { return }
        if let defaultProviderId = modelCatalog.defaultSessionProviderId,
           creatableProviders.contains(where: { $0.id == defaultProviderId }) {
            selectedProviderId = defaultProviderId
        } else {
            selectedProviderId = creatableProviders.first?.id ?? ""
        }
    }

    private var currentReasoningLevels: [String] {
        selectedModel?.reasoningLevels ?? []
    }

    private var selectedModel: CodexModel? {
        modelCatalog.codexModels.first(where: { $0.id == selectedModelId })
    }

    private var savedModelForCurrentAgent: String? {
        if selectedProviderId == "claude-sdk" {
            return nonEmptyNewSessionValue(defaultClaudeModel)
                ?? backendClient.settings?.newSessionDefaults?.claudeModel
        }
        return nonEmptyNewSessionValue(defaultCodexModel)
            ?? backendClient.settings?.newSessionDefaults?.codexModel
    }

    private var savedCodexReasoning: String? {
        nonEmptyNewSessionValue(defaultCodexReasoningLevel)
            ?? backendClient.settings?.newSessionDefaults?.codexReasoningLevel
    }

    private func loadModelsForCurrentAgent() {
        guard supportsModelSelection else {
            return
        }
        let provider = modelProviderForCurrentAgent
        guard modelCatalog.loadedModelProvider != provider || modelCatalog.codexModels.isEmpty else {
            applyDefaultModelIfNeeded(modelCatalog.codexDefaultModel)
            return
        }
        Task {
            await backendClient.loadModels(for: provider)
            await MainActor.run {
                applyDefaultModelIfNeeded(modelCatalog.codexDefaultModel)
            }
        }
    }

    private func applyDefaultModelIfNeeded(_ defaultModel: String?) {
        guard supportsModelSelection, selectedModelId.isEmpty else {
            return
        }
        selectedModelId = NewSessionModelSelection.preferredModelId(
            savedModelId: savedModelForCurrentAgent,
            providerDefaultModelId: defaultModel,
            models: modelCatalog.codexModels
        )
        applyDefaultReasoningIfNeeded()
    }

    private func applyDefaultReasoningIfNeeded(preferCurrentSelection: Bool = false) {
        guard supportsReasoningSelection else {
            selectedReasoningLevel = ""
            return
        }
        let preferredReasoning = preferCurrentSelection && !selectedReasoningLevel.isEmpty
            ? selectedReasoningLevel
            : savedCodexReasoning
        selectedReasoningLevel = NewSessionModelSelection.preferredReasoningLevel(
            savedReasoningLevel: preferredReasoning,
            providerDefaultReasoningLevel: modelCatalog.codexDefaultReasoningLevel,
            model: selectedModel
        )
    }

    private func saveNewSessionDefaults() {
        defaultSandboxMode = validatedSandboxMode(sandboxMode)
        defaultApprovalPolicy = validatedApprovalPolicy(approvalPolicy)
        if selectedProviderId == "codex-app-server" {
            defaultCodexModel = selectedModelId
            defaultCodexReasoningLevel = selectedReasoningLevel
        } else if selectedProviderId == "claude-sdk" {
            defaultClaudeModel = selectedModelId
        }
        Task {
            await backendClient.syncNewSessionDefaultsFromPreferences(force: true)
        }
        withAnimation(.easeOut(duration: 0.12)) {
            defaultSaveMessage = L10n("Saved")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.easeOut(duration: 0.12)) {
                defaultSaveMessage = nil
            }
        }
    }

    private func newSessionReasoningLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        case "xhigh": L10n("Extra High")
        default: value
        }
    }

    private func nonEmptyNewSessionValue(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func validatedSandboxMode(_ value: String) -> String {
        switch value {
        case "workspace-write", "danger-full-access", "read-only":
            return value
        default:
            return "workspace-write"
        }
    }

    private func validatedApprovalPolicy(_ value: String) -> String {
        switch value {
        case "on-request", "ask-risky", "never", "on-failure":
            return value
        default:
            return "on-request"
        }
    }

    private func startSelectedAgent(titleOverride: String? = nil) {
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTitle = titleOverride ?? (trimmedTitle.isEmpty ? defaultSessionTitle(for: workspace) : trimmedTitle)
        if selectedProviderId == "codex-app-server" && isBindingExistingSession {
            backendClient.createCodexPtyTask(
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                existingSessionId: existingSessionId,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId,
                reasoningLevel: selectedReasoningLevel,
                onNameConflict: { suggestedSessionTitle = $0 }
            ) {
                close()
            }
        } else {
            backendClient.createProviderTask(
                providerId: selectedProviderId,
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId,
                reasoningLevel: selectedReasoningLevel,
                onNameConflict: { suggestedSessionTitle = $0 }
            ) {
                close()
            }
        }
    }

    private var defaultSessionTitle: String {
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        return defaultSessionTitle(for: workspace)
    }

    private func defaultSessionTitle(for path: String) -> String {
        let folderName = URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
        return folderName.isEmpty ? "Agent" : "\(folderName)_agent"
    }

    private func chooseWorkspace() {
        if isBindingExistingSession {
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd)

        if panel.runModal() == .OK, let url = panel.url {
            WorkspaceAccessStore.shared.authorize(url)
            cwd = url.path
        }
    }

    private var isCreateDisabled: Bool {
        if backendClient.isCreatingTask {
            return true
        }
        if isLookingUpSession {
            return true
        }
        if isBindingExistingSession && sessionLookupMessage?.hasPrefix("Session not found") == true {
            return true
        }
        if supportsModelSelection && selectedModelId.isEmpty {
            return true
        }
        if supportsReasoningSelection && selectedReasoningLevel.isEmpty {
            return true
        }
        return selectedProvider == nil
    }

    private var isBindingExistingSession: Bool {
        !existingSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func scheduleSessionLookup(_ value: String) {
        sessionLookupTask?.cancel()
        let trimmedSessionId = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedSessionId.isEmpty {
            isLookingUpSession = false
            sessionLookupMessage = nil
            return
        }

        isLookingUpSession = true
        sessionLookupMessage = L10n("Resolving Codex session workspace...")
        sessionLookupTask = Task {
            try? await Task.sleep(for: .milliseconds(450))
            if Task.isCancelled {
                return
            }
            do {
                let result = try await backendClient.lookupCodexSession(trimmedSessionId)
                if Task.isCancelled {
                    return
                }
                await MainActor.run {
                    cwd = result.cwd ?? backendClient.defaultWorkspacePath
                    isLookingUpSession = false
                    sessionLookupMessage = L10n("Workspace loaded from bound Codex session.")
                }
            } catch {
                if Task.isCancelled {
                    return
                }
                await MainActor.run {
                    isLookingUpSession = false
                    sessionLookupMessage = "Session not found: \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct AgentPreset {
    let title: String
    let command: String
    let arguments: String
}

private struct PresetButton: View {
    let title: String
    let command: String
    let arguments: String
    let isSelected: Bool
    let isDisabled: Bool
    let action: (AgentPreset) -> Void

    var body: some View {
        Button {
            action(AgentPreset(title: title, command: command, arguments: arguments))
        } label: {
            Text(title)
                .font(.system(size: 11, weight: .bold))
                .frame(height: 26)
                .padding(.horizontal, 10)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? Color.black : CorptiePalette.primaryText)
        .background(isSelected ? CorptiePalette.softBlue.opacity(0.72) : Color.white.opacity(isDisabled ? 0.07 : 0.13), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(isSelected ? 0.28 : 0.16), lineWidth: 1))
        .disabled(isDisabled)
    }
}
