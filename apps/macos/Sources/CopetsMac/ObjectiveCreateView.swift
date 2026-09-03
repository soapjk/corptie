import SwiftUI

// Objective 创建弹窗（模块 C）：名称 + 描述 + 理想状态 + 优先级 + 高级折叠（标签/预算）。

struct ObjectiveCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var detail = ""
    @State private var idealState = ""
    @State private var priority: String? = nil
    @State private var tagsText = ""
    @State private var showAdvanced = false
    @State private var workspaceIds = Set<String>()
    @State private var relatedObjectiveIds = Set<String>()
    @State private var contributorAgentIds = Set<String>()
    @State private var avatarSourcePath: String?
    @State private var creationId = "objective:\(UUID().uuidString.lowercased())"

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n("创建 Objective"))
                        .font(.title3.bold())

                    HStack(spacing: 12) {
                        objectiveAvatar(path: avatarSourcePath, size: 52)
                        Button(L10n("选择头像")) { chooseAvatar() }
                        if avatarSourcePath != nil {
                            Button(L10n("清除头像")) { avatarSourcePath = nil }
                        }
                    }

                    FormAssistPanel(
                        formType: .objective,
                        promptHint: L10n("例如：统一三个创建页的一键填充体验，并确保生成内容可检查、可编辑。"),
                        currentValues: {
                            [
                                "name": name,
                                "description": detail,
                                "idealState": idealState,
                                "priority": priority ?? "",
                                "tags": tagsText
                            ]
                        },
                        onApply: applyGeneratedFields
                    )

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
                    }
                    field(L10n("理想状态")) {
                        TextEditor(text: $idealState)
                            .font(.body)
                            .frame(height: 70)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    }

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

                    Divider()

                    ObjectiveResourcesEditor(
                        workspaceIds: $workspaceIds,
                        relatedObjectiveIds: $relatedObjectiveIds,
                        contributorAgentIds: $contributorAgentIds,
                        excludeObjectiveId: nil
                    )
                    if contributorAgentIds.isEmpty {
                        Text(L10n("请至少选择一个 Contributor Agent；创建 Objective 时会由其中一个 Agent 建立 Objective Chat。"))
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

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
                    if create() { dismiss() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || contributorAgentIds.isEmpty
                )
            }
            .padding(16)
        }
        .frame(width: 500, height: 580)
    }

    private func create() -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !contributorAgentIds.isEmpty else { return false }

        let tags = tagsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let requestId = creationId
        let requestDetail = detail
        let requestIdealState = idealState
        let requestAvatarSourcePath = avatarSourcePath
        let requestPriority = priority
        let requestWorkspaceIds = Array(workspaceIds)
        let requestRelatedObjectiveIds = Array(relatedObjectiveIds)
        let requestContributorAgentIds = Array(contributorAgentIds)
        return BackgroundTaskCenter.shared.start(
            id: requestId,
            title: L10nFormat("创建 Objective：%@", trimmed)
        ) {
            let objective = await client.createObjective(
                id: requestId,
                name: trimmed,
                description: requestDetail.isEmpty ? nil : requestDetail,
                idealState: requestIdealState.isEmpty ? nil : requestIdealState,
                avatarPath: requestAvatarSourcePath,
                priority: requestPriority,
                tags: tags,
                workspaceIds: requestWorkspaceIds,
                relatedObjectiveIds: requestRelatedObjectiveIds,
                contributorAgentIds: requestContributorAgentIds
            )
            if objective != nil {
                return .success(L10nFormat("Objective“%@”已创建。", trimmed))
            }
            return .failure(client.errorMessage ?? L10n("Objective 创建失败，可重试。"))
        }
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.gif, .png, .jpeg, .heic, .tiff, .image]
        if panel.runModal() == .OK {
            avatarSourcePath = panel.url?.path
        }
    }

    private func objectiveAvatar(path: String?, size: CGFloat) -> some View {
        Group {
            if let path, !path.isEmpty {
                AnimatedAvatarImage(path: path)
            } else {
                DefaultInitialAvatarView(
                    familySeed: name,
                    variationSeed: creationId,
                    initials: DefaultAvatarInitials.make(from: name),
                    size: size
                )
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private func applyGeneratedFields(_ fields: [String: String]) {
        name = fields["name"] ?? name
        detail = fields["description"] ?? detail
        idealState = fields["idealState"] ?? idealState
        if let generatedPriority = fields["priority"] {
            priority = generatedPriority.isEmpty ? nil : generatedPriority
        }
        tagsText = fields["tags"] ?? tagsText
        if !tagsText.isEmpty { showAdvanced = true }
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
