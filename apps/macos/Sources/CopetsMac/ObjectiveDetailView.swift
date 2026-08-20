import SwiftUI

// Objective 详情/编辑页（模块 C 升级）：完整编辑所有字段 + 三挂靠资源（Workspace / 关联 Objective / Contributor Agent）。
// 侧栏 Objective 右键「编辑」打开此 sheet；创建后的资源挂靠也可在此修改。

struct ObjectiveDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let objective: Objective

    @State private var name: String
    @State private var detail: String
    @State private var idealState: String
    @State private var priority: String?
    @State private var hasTargetDate: Bool
    @State private var targetDate: Date
    @State private var tagsText: String
    @State private var showAdvanced = false
    @State private var workspaceIds = Set<String>()
    @State private var relatedObjectiveIds = Set<String>()
    @State private var contributorAgentIds = Set<String>()
    @State private var showDeleteConfirm = false
    @State private var assistAgentId: String?

    init(objective: Objective) {
        self.objective = objective
        _name = State(initialValue: objective.name)
        _detail = State(initialValue: objective.description)
        _idealState = State(initialValue: objective.idealState)
        _priority = State(initialValue: objective.priority)
        _hasTargetDate = State(initialValue: objective.targetDate != nil)
        _targetDate = State(initialValue: Self.parseDate(objective.targetDate) ?? Date())
        _tagsText = State(initialValue: objective.tags.joined(separator: ", "))
        _workspaceIds = State(initialValue: Set(objective.workspaceIds))
        _relatedObjectiveIds = State(initialValue: Set(objective.relatedObjectiveIds))
        _contributorAgentIds = State(initialValue: Set(objective.contributorAgentIds))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n("编辑 Objective"))
                        .font(.title3.bold())

                    field(L10n("名称 *")) {
                        TextField(L10n("目标名称"), text: $name)
                    }
                    field(L10n("描述")) {
                        TextEditor(text: $detail)
                            .font(.body)
                            .frame(height: 70)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    } trailing: {
                        AgentAssistButton(fieldLabel: "描述", text: $detail, selectedAgentId: $assistAgentId, context: "目标名称：\(name)")
                    }
                    field(L10n("理想状态")) {
                        TextEditor(text: $idealState)
                            .font(.body)
                            .frame(height: 70)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    } trailing: {
                        AgentAssistButton(fieldLabel: "理想状态", text: $idealState, selectedAgentId: $assistAgentId, context: "目标名称：\(name)；描述：\(detail)")
                    }

                    HStack(spacing: 24) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(L10n("优先级"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Picker("", selection: $priority) {
                                Text(L10n("未设置")).tag(String?.none)
                                Text(L10n("低")).tag(String?.some("low"))
                                Text(L10n("中")).tag(String?.some("medium"))
                                Text(L10n("高")).tag(String?.some("high"))
                                Text(L10n("紧急")).tag(String?.some("urgent"))
                            }
                            .labelsHidden()
                            .frame(maxWidth: 160, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Toggle(L10n("设置目标日期"), isOn: $hasTargetDate)
                                .font(.caption)
                            if hasTargetDate {
                                DatePicker("", selection: $targetDate, displayedComponents: .date)
                                    .labelsHidden()
                            }
                        }
                    }

                    Divider()

                    ObjectiveResourcesEditor(
                        workspaceIds: $workspaceIds,
                        relatedObjectiveIds: $relatedObjectiveIds,
                        contributorAgentIds: $contributorAgentIds,
                        excludeObjectiveId: objective.id
                    )

                    DisclosureGroup(L10n("高级选项"), isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: 12) {
                            field(L10n("标签（逗号分隔）")) {
                                TextField(L10n("如：后端, 重构, 性能"), text: $tagsText)
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(24)
            }

            Divider()

            HStack {
                Button {
                    showDeleteConfirm = true
                } label: {
                    Label(L10n("删除"), systemImage: "trash")
                        .foregroundStyle(.red)
                }
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("保存")) {
                    save()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(16)
        }
        .frame(width: 500, height: 580)
        .alert(L10n("删除 Objective"), isPresented: $showDeleteConfirm) {
            Button(L10n("删除"), role: .destructive) {
                Task { await client.deleteObjective(objectiveId: objective.id) }
                dismiss()
            }
            Button(L10n("取消"), role: .cancel) {}
        } message: {
            Text(L10nFormat("Delete “%@”? All of its WorkItems will be deleted. This action cannot be undone.", objective.name))
        }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let tags = tagsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        Task {
            let updatedObjective = await client.updateObjective(
                objectiveId: objective.id,
                name: trimmed,
                description: detail,
                idealState: idealState,
                priority: priority ?? "",
                targetDate: hasTargetDate ? Self.dateString(targetDate) : "",
                tags: tags,
                workspaceIds: Array(workspaceIds),
                relatedObjectiveIds: Array(relatedObjectiveIds),
                contributorAgentIds: Array(contributorAgentIds)
            )
            if updatedObjective != nil {
                dismiss()
            }
        }
    }

    private static func dateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func parseDate(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }

    private func field(_ label: String, @ViewBuilder content: () -> some View, @ViewBuilder trailing: () -> some View = { EmptyView() }) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                trailing()
                Spacer()
            }
            content()
        }
    }
}
