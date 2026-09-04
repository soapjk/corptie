import SwiftUI
import UniformTypeIdentifiers

// Work 详情/编辑页。Workspace 是创建后不可换绑的唯一资源。

struct WorkDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let work: Work

    @State private var name: String
    @State private var detail: String
    @State private var tagsText: String
    @State private var showAdvanced = false
    @State private var workspaceId: String?
    @State private var contributorAgentIds = Set<String>()
    @State private var showDeleteConfirm = false
    @State private var assistAgentId: String?

    init(work: Work) {
        self.work = work
        _name = State(initialValue: work.name)
        _detail = State(initialValue: work.description)
        _tagsText = State(initialValue: work.tags.joined(separator: ", "))
        _workspaceId = State(initialValue: work.workspaceId)
        _contributorAgentIds = State(initialValue: Set(work.contributorAgentIds))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n("编辑 Work"))
                        .font(.title3.bold())

                    HStack(spacing: 12) {
                        workAvatar
                        Button(L10n("选择头像")) { chooseAvatar() }
                        if currentAvatarPath != nil {
                            Button(L10n("清除头像")) {
                                Task { await client.clearWorkAvatar(workId: work.id) }
                            }
                        }
                    }

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
                    Divider()

                    WorkResourcesEditor(
                        workspaceId: $workspaceId,
                        contributorAgentIds: $contributorAgentIds,
                        workspaceEditable: false
                    )

                    DisclosureGroup(L10n("Work Memories")) {
                        MemoryManagementView(scope: .owner(type: "work", id: work.id))
                            .frame(height: 300)
                            .padding(.top, 8)
                    }

                    Divider()

                    ArtifactSectionView(workId: work.id, taskId: nil)

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
        .frame(width: 620, height: 680)
        .alert(L10n("删除 Work"), isPresented: $showDeleteConfirm) {
            Button(L10n("删除"), role: .destructive) {
                Task { await client.deleteWork(workId: work.id) }
                dismiss()
            }
            Button(L10n("取消"), role: .cancel) {}
        } message: {
            Text(L10nFormat("Delete “%@”? All of its CorptieTasks will be deleted. This action cannot be undone.", work.name))
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
            let updatedWork = await client.updateWork(
                workId: work.id,
                name: trimmed,
                description: detail,
                tags: tags,
                contributorAgentIds: Array(contributorAgentIds)
            )
            if updatedWork != nil {
                dismiss()
            }
        }
    }

    private var currentAvatarPath: String? {
        client.works.first(where: { $0.id == work.id })?.avatarPath ?? work.avatarPath
    }

    private var workAvatar: some View {
        ObjectiveAvatarView(
            objectiveID: work.id,
            name: name,
            avatarPath: currentAvatarPath,
            size: 52
        )
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = AvatarImageSupport.allowedContentTypes
        if panel.runModal() == .OK, let url = panel.url {
            Task { await client.setWorkAvatar(workId: work.id, sourcePath: url.path) }
        }
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
