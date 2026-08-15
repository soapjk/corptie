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

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("创建 Objective")
                        .font(.title3.bold())

                    field("名称 *") {
                        TextField("目标名称", text: $name)
                    }
                    field("描述") {
                        TextEditor(text: $detail)
                            .font(.body)
                            .frame(height: 70)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    }
                    field("验收标准") {
                        TextEditor(text: $acceptanceCriteria)
                            .font(.body)
                            .frame(height: 70)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    }

                    HStack(spacing: 24) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("优先级")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Picker("", selection: $priority) {
                                Text("未设置").tag(String?.none)
                                Text("低").tag(String?.some("low"))
                                Text("中").tag(String?.some("medium"))
                                Text("高").tag(String?.some("high"))
                                Text("紧急").tag(String?.some("urgent"))
                            }
                            .labelsHidden()
                            .frame(maxWidth: 160, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Toggle("设置目标日期", isOn: $hasTargetDate)
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

                    DisclosureGroup("高级选项", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: 12) {
                            field("标签（逗号分隔）") {
                                TextField("如：后端, 重构, 性能", text: $tagsText)
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
                Button("取消") { dismiss() }
                Button("创建") {
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

    private func field(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
    }
}
