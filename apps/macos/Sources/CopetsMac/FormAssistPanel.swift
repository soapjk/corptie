import SwiftUI

enum AssistFormType: String, Encodable {
    case agent
    case objective
    case task
}

struct AssistFormDraft: Decodable, Equatable {
    let formType: String
    let fields: [String: String]
    let providerId: String?

    private enum CodingKeys: String, CodingKey {
        case formType
        case fields
        case providerId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        formType = try container.decode(String.self, forKey: .formType)
        fields = try container.decode([String: String].self, forKey: .fields)
        providerId = try container.decodeIfPresent(String.self, forKey: .providerId)

        let expected: Set<String>
        switch formType {
        case AssistFormType.agent.rawValue:
            expected = ["name", "description", "role", "systemPrompt", "capabilities"]
        case AssistFormType.objective.rawValue:
            expected = ["name", "description", "idealState", "priority", "tags"]
        case AssistFormType.task.rawValue:
            expected = ["title", "description", "acceptanceCriteria", "priority"]
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .formType,
                in: container,
                debugDescription: "Unsupported assist form type: \(formType)"
            )
        }
        guard Set(fields.keys) == expected else {
            throw DecodingError.dataCorruptedError(
                forKey: .fields,
                in: container,
                debugDescription: "Generated fields do not match the \(formType) form contract."
            )
        }
    }
}

enum FormAssistOverwritePolicy {
    static func hasMeaningfulExistingContent(formType: AssistFormType, values: [String: String]) -> Bool {
        let defaults: [String: String]
        switch formType {
        case .agent:
            defaults = ["role": "independentContributor"]
        case .objective:
            defaults = [:]
        case .task:
            defaults = ["priority": "medium"]
        }
        return values.contains { key, value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.isEmpty && defaults[key] != trimmed
        }
    }

    static func formChanged(since snapshot: [String: String], current: [String: String]) -> Bool {
        snapshot != current
    }
}

private enum FormAssistConfirmation: Identifiable {
    case overwrite
    case undoEdited
    case applyChanged([String: String])

    var id: String {
        switch self {
        case .overwrite: "overwrite"
        case .undoEdited: "undoEdited"
        case .applyChanged: "applyChanged"
        }
    }
}

/// Shared one-shot drafting surface for entity creation forms.
/// Generated values only update local form state; creation remains a separate user action.
struct FormAssistPanel: View {
    let formType: AssistFormType
    let promptHint: String
    let currentValues: () -> [String: String]
    let onApply: ([String: String]) -> Void
    var cwd: String? = nil

    @ObservedObject private var client = EntityAPIClient.shared
    @State private var isExpanded = false
    @State private var intent = ""
    @State private var isGenerating = false
    @State private var errorText: String?
    @State private var didApplyDraft = false
    @State private var hasGenerated = false
    @State private var statusText: String?
    @State private var previousValues: [String: String]?
    @State private var lastAppliedValues: [String: String]?
    @State private var confirmation: FormAssistConfirmation?
    @State private var selectedAgentId: String?
    @State private var showAgentPicker = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("用一段话填写整个表单"))
                        .font(.callout.weight(.medium))
                    Text(L10n("AI 只会回填草稿，你仍可逐项检查和编辑。"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
                } label: {
                    Label(L10n("帮我写"), systemImage: "sparkles")
                }
                .disabled(isGenerating)
            }

            if isExpanded {
                TextEditor(text: $intent)
                    .font(.body)
                    .frame(height: 76)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    .overlay(alignment: .topLeading) {
                        if intent.isEmpty {
                            Text(promptHint)
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 13)
                                .allowsHitTesting(false)
                        }
                    }

                HStack(spacing: 8) {
                    Button {
                        showAgentPicker = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "person.crop.circle.badge.checkmark")
                            Text(selectedAgentName ?? L10n("使用默认 Agent"))
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption2)
                        }
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(selectedAgentName == nil ? .secondary : .primary)

                    if selectedAgentId != nil {
                        Button {
                            selectedAgentId = nil
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help(L10n("清除，使用默认 Agent"))
                    }

                    Spacer()
                    if isGenerating {
                        ProgressView().controlSize(.small)
                        Text(L10n("正在生成…"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Button(hasGenerated ? L10n("重新生成并填入") : L10n("生成并填入")) {
                        requestGeneration()
                    }
                    .disabled(trimmedIntent.isEmpty || isGenerating)
                }

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if let statusText {
                    HStack(spacing: 8) {
                        Label(statusText, systemImage: didApplyDraft ? "checkmark.circle.fill" : "arrow.uturn.backward.circle.fill")
                            .font(.caption)
                            .foregroundStyle(didApplyDraft ? .green : .secondary)
                        if previousValues != nil, didApplyDraft {
                            Button(L10n("撤销填入")) { requestUndo() }
                                .buttonStyle(.borderless)
                                .font(.caption)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.accentColor.opacity(0.18), lineWidth: 1))
        .sheet(isPresented: $showAgentPicker) {
            AgentSinglePickerView(selectedId: $selectedAgentId)
        }
        .alert(item: $confirmation) { value in
            switch value {
            case .overwrite:
                return Alert(
                    title: Text(L10n("覆盖已有内容？")),
                    message: Text(L10n("生成结果将替换当前表单中的非空字段。你可以在填入后撤销。")),
                    primaryButton: .destructive(Text(L10n("继续生成"))) {
                        performGeneration(snapshot: currentValues())
                    },
                    secondaryButton: .cancel(Text(L10n("取消")))
                )
            case .undoEdited:
                return Alert(
                    title: Text(L10n("撤销并放弃后续编辑？")),
                    message: Text(L10n("表单在生成后已被修改。撤销会恢复生成前内容，并丢弃这些后续编辑。")),
                    primaryButton: .destructive(Text(L10n("仍要撤销"))) { restorePreviousValues() },
                    secondaryButton: .cancel(Text(L10n("保留编辑")))
                )
            case let .applyChanged(fields):
                return Alert(
                    title: Text(L10n("表单内容已变化")),
                    message: Text(L10n("生成期间表单被修改。是否用生成结果覆盖当前内容？填入后仍可撤销。")),
                    primaryButton: .destructive(Text(L10n("覆盖并填入"))) {
                        applyDraft(fields, replacing: currentValues())
                    },
                    secondaryButton: .cancel(Text(L10n("保留当前内容")))
                )
            }
        }
        .task {
            if client.agents.isEmpty { await client.refreshAgents() }
        }
    }

    private var trimmedIntent: String {
        intent.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var selectedAgentName: String? {
        guard let selectedAgentId else { return nil }
        return client.agents.first { $0.agentId == selectedAgentId }?.name
    }

    private func requestGeneration() {
        guard !trimmedIntent.isEmpty else { return }
        let values = currentValues()
        if FormAssistOverwritePolicy.hasMeaningfulExistingContent(formType: formType, values: values) {
            confirmation = .overwrite
        } else {
            performGeneration(snapshot: values)
        }
    }

    private func performGeneration(snapshot: [String: String]) {
        isGenerating = true
        errorText = nil
        statusText = nil
        Task {
            if let draft = await client.assistFormDraft(
                formType: formType,
                prompt: trimmedIntent,
                currentValues: snapshot,
                cwd: cwd,
                agentId: selectedAgentId
            ) {
                if FormAssistOverwritePolicy.formChanged(since: snapshot, current: currentValues()) {
                    confirmation = .applyChanged(draft.fields)
                } else {
                    applyDraft(draft.fields, replacing: snapshot)
                }
            } else {
                errorText = client.errorMessage ?? L10n("生成失败，请稍后重试。")
            }
            isGenerating = false
        }
    }

    private func applyDraft(_ fields: [String: String], replacing values: [String: String]) {
        previousValues = values
        lastAppliedValues = fields
        onApply(fields)
        hasGenerated = true
        didApplyDraft = true
        statusText = L10n("草稿已填入下方表单，请逐项检查后再创建。")
        errorText = nil
    }

    private func requestUndo() {
        guard previousValues != nil else { return }
        if let lastAppliedValues,
           FormAssistOverwritePolicy.formChanged(since: lastAppliedValues, current: currentValues()) {
            confirmation = .undoEdited
        } else {
            restorePreviousValues()
        }
    }

    private func restorePreviousValues() {
        guard let previousValues else { return }
        onApply(previousValues)
        self.previousValues = nil
        lastAppliedValues = nil
        didApplyDraft = false
        statusText = L10n("已恢复生成前的表单内容。")
    }
}
