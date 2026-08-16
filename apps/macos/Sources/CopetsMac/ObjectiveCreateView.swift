import SwiftUI

// Objective 创建弹窗（模块 C）：名称 + 描述 + 验收标准 + 优先级 + 目标日期 + 高级折叠（标签/预算）。

struct ObjectiveCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var detail = ""
    @State private var acceptanceCriteria = ""
    @State private var priority: String? = nil
    @State private var hasTargetDate = false
    @State private var targetDate = Date()
    @State private var tagsText = ""
    @State private var showAdvanced = false
    @State private var workspaceIds = Set<String>()
    @State private var relatedObjectiveIds = Set<String>()
    @State private var contributorAgentIds = Set<String>()
    @State private var assistAgentId: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n("创建 Objective"))
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
                    field(L10n("验收标准")) {
                        TextEditor(text: $acceptanceCriteria)
                            .font(.body)
                            .frame(height: 70)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    } trailing: {
                        AgentAssistButton(fieldLabel: "验收标准", text: $acceptanceCriteria, selectedAgentId: $assistAgentId, context: "目标名称：\(name)；描述：\(detail)")
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
                        excludeObjectiveId: nil
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
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("创建")) {
                    create()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(16)
        }
        .frame(width: 500, height: 580)
    }

    private func create() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let tags = tagsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        Task {
            await client.createObjective(
                name: trimmed,
                description: detail.isEmpty ? nil : detail,
                acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                priority: priority,
                targetDate: hasTargetDate ? Self.dateString(targetDate) : nil,
                tags: tags,
                workspaceIds: Array(workspaceIds),
                relatedObjectiveIds: Array(relatedObjectiveIds),
                contributorAgentIds: Array(contributorAgentIds)
            )
        }
    }

    private static func dateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
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
