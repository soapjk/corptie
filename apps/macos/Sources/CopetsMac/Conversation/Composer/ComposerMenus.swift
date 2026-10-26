import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Existing callers keep their catalog/command subscriptions here. A retained
/// page uses the value-only menu surface directly.
struct CodexModelMenu: View {
    @ObservedObject var modelCatalog: ProviderCatalogStore
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    let maxWidth: CGFloat
    let session: TaskSession?
    var activity: ConversationDetailPresentationActivity? = nil
    var body: some View {
        SessionModelMenuSurface(models: modelCatalog.models(for: session?.external?.provider),
            defaultModelID: modelCatalog.defaultModel(for: session?.external?.provider),
            defaultReasoningLevel: modelCatalog.defaultReasoning(for: session?.external?.provider),
            loadingModels: modelCatalog.isLoadingCodexModels, switchingModel: backendClient.isSwitchingModel,
            switchingReasoning: backendClient.isSwitchingReasoning, backendClient: backendClient,
            maxWidth: maxWidth, session: session, activity: activity)
    }
}

struct SessionModelMenuSurface: View {
    let models: [CodexModel]
    let defaultModelID: String?
    let defaultReasoningLevel: String?
    let loadingModels: Bool
    let switchingModel: Bool
    let switchingReasoning: Bool
    let backendClient: BackendClient
    let maxWidth: CGFloat
    let session: TaskSession?
    var activity: ConversationDetailPresentationActivity? = nil
    var renderInputs: SessionPageRenderInputs? = nil
    private var canAct: Bool {
        if let renderInputs { return renderInputs.actionSession(generation: renderInputs.activity.generation) != nil }
        return (activity?.allows(generation: activity?.generation ?? 0) ?? true)
            && session?.id != nil && backendClient.sessionSelectionController.selectedSessionID == session?.id
            && backendClient.selectedSession?.external?.provider == session?.external?.provider
    }

    var body: some View {
        let _ = SessionSwitchTrace.shared.mark(.modelMenuBody, sessionID: session?.id ?? "")
        Menu {
            if loadingModels {
                Text(L10n("Loading models"))
            } else if models.isEmpty {
                Button {
                    reloadModels()
                } label: {
                    Label(L10n("Reload models"), systemImage: "arrow.clockwise")
                }
            } else {
                ForEach(models) { model in
                    Button {
                        guard canAct else { return }
                        backendClient.switchSelectedCodexModel(to: model)
                    } label: {
                        HStack {
                            Text(model.name)
                            if model.id == currentModelId {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                    .help(model.description ?? model.id)
                    .disabled(!supportsModelSwitch)
                }

                Divider()

                if supportsReasoningSwitch {
                    Divider()

                    Menu {
                        if currentReasoningLevels.isEmpty {
                            Text(L10n("No reasoning options"))
                        } else {
                            ForEach(currentReasoningLevels, id: \.self) { reasoningLevel in
                                Button {
                                    guard canAct else { return }
                                    backendClient.switchSelectedCodexReasoning(to: reasoningLevel)
                                } label: {
                                    HStack {
                                        Text(reasoningLabel(reasoningLevel))
                                        if reasoningLevel == currentReasoningLevel {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                                .help(reasoningDescription(reasoningLevel))
                            }
                        }
                    } label: {
                        Label(L10nFormat("Reasoning: %@", reasoningLabel(currentReasoningLevel)), systemImage: "brain")
                    }
                    .disabled(currentReasoningLevels.isEmpty || switchingReasoning)
                }

                Button {
                    reloadModels()
                } label: {
                    Label(L10n("Reload models"), systemImage: "arrow.clockwise")
                }
            }
        } label: {
            ComposerModelMenuLabel(
                modelLabel: currentModelLabel,
                reasoningShortLabel: reasoningShortLabel(currentReasoningLevel),
                isBusy: switchingModel || switchingReasoning
                    || loadingModels,
                maxWidth: maxWidth,
                showsSurface: false
            )
        }
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .disabled(!SessionConfigurationMenuAvailability.isEnabled(
            canSwitchModel: supportsModelSwitch,
            canSwitchReasoning: supportsReasoningSwitch,
            isSwitchingModel: switchingModel,
            isSwitchingReasoning: switchingReasoning
        ))
        .help(currentModelHelp)
    }

    private func reloadModels() {
        let generation = activity?.generation ?? 0
        guard canAct else { return }
        Task {
            guard activity?.allows(generation: generation) ?? true, canAct else { return }
            await backendClient.loadModelsForSelectedSession(forceRefresh: true)
        }
    }

    private var currentModelId: String {
        session?.external?.currentModel
            ?? defaultModelID
            ?? ""
    }

    private var currentModelLabel: String {
        guard !currentModelId.isEmpty else {
            return L10n("Model")
        }
        return models.first(where: { $0.id == currentModelId })?.name ?? currentModelId
    }

    private var currentModelHelp: String {
        let action = supportsReasoningSwitch ? L10n("Switch model or reasoning") : L10n("Switch model")
        guard !currentModelId.isEmpty else {
            return action
        }
        return L10nFormat("%@: %@", action, currentModelLabel)
    }

    private var currentModel: CodexModel? {
        models.first(where: { $0.id == currentModelId })
    }

    private var currentReasoningLevel: String {
        SessionReasoningSelection.currentLevel(
            sessionLevel: session?.external?.currentReasoningLevel,
            providerDefaultLevel: defaultReasoningLevel,
            model: currentModel
        )
    }

    private var currentReasoningLevels: [String] {
        SessionReasoningSelection.availableLevels(
            modelID: currentModelId,
            models: models,
            supportsSwitch: supportsReasoningSwitch
        )
    }

    private var supportsReasoningSwitch: Bool {
        session?.actions?.switchReasoning.available
            ?? session?.capabilities?.canSwitchReasoning
            ?? false
    }

    private var supportsModelSwitch: Bool {
        session?.actions?.switchModel.available
            ?? session?.capabilities?.canSwitchModel
            ?? false
    }

    private var currentProvider: String {
        session?.external?.provider ?? "codex-pty"
    }

    private func reasoningLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        case "xhigh": L10n("Extra High")
        default: value
        }
    }

    private func reasoningShortLabel(_ value: String) -> String {
        ComposerModelLabel.reasoningShort(value)
    }

    private func reasoningDescription(_ value: String) -> String {
        switch value.lowercased() {
        case "low": L10n("Fast responses with lighter reasoning")
        case "medium": L10n("Balanced speed and reasoning")
        case "high": L10n("Greater reasoning depth")
        case "xhigh": L10n("Extra high reasoning depth")
        default: value
        }
    }
}

enum SessionReasoningSelection {
    static func availableLevels(
        modelID: String,
        models: [CodexModel],
        supportsSwitch: Bool
    ) -> [String] {
        guard supportsSwitch else { return [] }
        return models.first(where: { $0.id == modelID })?.reasoningLevels ?? []
    }

    static func currentLevel(
        sessionLevel: String?,
        providerDefaultLevel: String?,
        model: CodexModel?
    ) -> String {
        sessionLevel ?? providerDefaultLevel ?? model?.defaultReasoningLevel ?? "medium"
    }
}

enum SessionConfigurationMenuAvailability {
    static func isEnabled(
        canSwitchModel: Bool,
        canSwitchReasoning: Bool,
        isSwitchingModel: Bool,
        isSwitchingReasoning: Bool
    ) -> Bool {
        ComposerModelLabel.menuEnabled(
            canSwitchModel: canSwitchModel,
            canSwitchReasoning: canSwitchReasoning,
            isSwitchingModel: isSwitchingModel,
            isSwitchingReasoning: isSwitchingReasoning
        )
    }
}

enum ModelMenuLabel {
    static let maximumCharacterCount = ComposerModelLabel.maximumCharacterCount

    static func compact(_ value: String) -> String {
        ComposerModelLabel.compact(value)
    }
}

struct ComposerMentionMenu: View {
    let candidates: [ComposerMentionCandidate]
    let selectedIndex: Int
    let onSelect: (ComposerMentionCandidate) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n("Mention a Work or Session"))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .padding(.horizontal, 10)
                .padding(.top, 8)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(candidates.enumerated()), id: \.element.id) { index, candidate in
                            Button {
                                onSelect(candidate)
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: candidate.symbol)
                                        .frame(width: 18)
                                        .foregroundStyle(CorptiePalette.softBlue)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(candidate.mention.displayName)
                                            .font(.system(size: 12, weight: .medium))
                                            .lineLimit(1)
                                        Text(candidate.detail)
                                            .font(.system(size: 10))
                                            .foregroundStyle(CorptiePalette.secondaryText)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 8)
                                .padding(.leading, candidate.mention.targetType == .session ? 12 : 0)
                                .frame(height: 38)
                                .background(
                                    index == selectedIndex ? CorptiePalette.softBlue.opacity(0.12) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                )
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .id(candidate.id)
                            .accessibilityLabel("\(candidate.mention.displayName), \(candidate.detail)")
                            .accessibilityAddTraits(index == selectedIndex ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
                }
                .onChange(of: selectedIndex) { _, index in
                    guard candidates.indices.contains(index) else { return }
                    proxy.scrollTo(candidates[index].id, anchor: .center)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n("Mention suggestions"))
    }
}
