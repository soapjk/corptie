import SwiftUI

enum AgentSkillAssignment {
    static func installedSkills(from skills: [Skill], selectedSkillIds: Set<String>) -> [Skill] {
        skills.filter { selectedSkillIds.contains($0.skillId) }
    }

    static func toggled(_ skillId: String, in selectedSkillIds: Set<String>) -> Set<String> {
        var result = selectedSkillIds
        if !result.insert(skillId).inserted {
            result.remove(skillId)
        }
        return result
    }
}

struct AgentInstalledSkillsView: View {
    let skills: [Skill]
    @Binding var selectedSkillIds: Set<String>
    let isEnabled: Bool
    let onAdd: () -> Void

    private var installedSkills: [Skill] {
        AgentSkillAssignment.installedSkills(from: skills, selectedSkillIds: selectedSkillIds)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(L10n("已安装 Skill"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .frame(width: 18, height: 18)
                }
                .buttonStyle(.borderless)
                .disabled(!isEnabled)
                .help(L10n("添加 Skill"))
                .accessibilityLabel(L10n("添加 Skill"))
            }

            Text(isEnabled
                 ? L10n("这些 Skill 已加入该 Agent 的查询范围，并会在需要时按需加载。")
                 : L10n("当前 Provider 不支持会话内 Skill 查询和懒加载。"))
                .font(.caption2)
                .foregroundStyle(isEnabled ? Color.secondary : Color.orange)

            if installedSkills.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "shippingbox")
                        .foregroundStyle(.secondary)
                    Text(L10n("尚未给此 Agent 安装 Skill。"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(action: onAdd) {
                        Label(L10n("添加 Skill"), systemImage: "plus")
                    }
                    .buttonStyle(.borderless)
                    .disabled(!isEnabled)
                }
                .padding(10)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(installedSkills.enumerated()), id: \.element.skillId) { index, skill in
                        installedSkillRow(skill)
                        if index < installedSkills.count - 1 { Divider() }
                    }
                }
                .padding(.horizontal, 10)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
            }
        }
    }

    private func installedSkillRow(_ skill: Skill) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "shippingbox.fill")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.manifestName ?? skill.name)
                    .font(.callout)
                let summary = skill.manifestDescription ?? skill.description
                if !summary.isEmpty {
                    Text(summary)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Text(skill.isGit ? "git" : L10n("本地"))
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Button {
                selectedSkillIds.remove(skill.skillId)
            } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .disabled(!isEnabled)
            .help(L10nFormat("从 Agent 移除 %@", skill.manifestName ?? skill.name))
            .accessibilityLabel(L10nFormat("从 Agent 移除 %@", skill.manifestName ?? skill.name))
        }
        .padding(.vertical, 8)
    }
}

struct AgentSkillPickerView: View {
    let skills: [Skill]
    let selectedSkillIds: Set<String>
    let onConfirm: (Set<String>) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draftSelection: Set<String>
    @State private var query = ""

    init(skills: [Skill], selectedSkillIds: Set<String>, onConfirm: @escaping (Set<String>) -> Void) {
        self.skills = skills
        self.selectedSkillIds = selectedSkillIds
        self.onConfirm = onConfirm
        _draftSelection = State(initialValue: selectedSkillIds)
    }

    private var filteredSkills: [Skill] {
        guard !query.isEmpty else { return skills }
        return skills.filter {
            "\($0.manifestName ?? $0.name) \($0.manifestDescription ?? $0.description)"
                .localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("选择 Skill"))
                .font(.headline)
            Text(L10n("选择系统中已有的 Skill；确认后会更新 Agent Profile 中的已安装列表。"))
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(L10n("搜索 Skill"), text: $query)
                .textFieldStyle(.roundedBorder)

            if skills.isEmpty {
                ContentUnavailableView(
                    L10n("No Skills"),
                    systemImage: "shippingbox",
                    description: Text(L10n("请先在 Agent 页面登记 Skill。"))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filteredSkills.isEmpty {
                ContentUnavailableView.search(text: query)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(filteredSkills) { skill in
                            skillOption(skill)
                            Divider()
                        }
                    }
                }
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
            }

            HStack {
                Text(L10nFormat("已选择 %d 个 Skill", draftSelection.count))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(L10nFormat("已选择 %d 个 Skill", draftSelection.count))
                Spacer()
                Button(L10n("取消"), role: .cancel) { dismiss() }
                Button(L10n("确定")) {
                    onConfirm(draftSelection)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(draftSelection == selectedSkillIds)
                .help(draftSelection == selectedSkillIds ? L10n("Skill 选择尚未更改") : L10n("确认 Skill 选择"))
            }
        }
        .padding(20)
        .frame(width: 520, height: 520)
    }

    private func skillOption(_ skill: Skill) -> some View {
        let isSelected = draftSelection.contains(skill.skillId)
        return Button {
            draftSelection = AgentSkillAssignment.toggled(skill.skillId, in: draftSelection)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.manifestName ?? skill.name)
                        .font(.callout)
                    let summary = skill.manifestDescription ?? skill.description
                    if !summary.isEmpty {
                        Text(summary)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(10)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(skill.manifestName ?? skill.name)
        .accessibilityValue(isSelected ? L10n("已选择") : L10n("未选择"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct AgentSkillSelectionView: View {
    let skills: [Skill]
    @Binding var selectedSkillIds: Set<String>
    let isEnabled: Bool
    let onRegister: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(L10n("可用 Skill"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: onRegister) {
                    Label(L10n("登记"), systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .disabled(!isEnabled)
            }

            Text(isEnabled
                 ? L10n("选中的 Skill 会加入该 Agent 的查询范围，并在需要时按需加载。")
                 : L10n("当前 Provider 不支持会话内 Skill 查询和懒加载。"))
                .font(.caption2)
                .foregroundStyle(isEnabled ? Color.secondary : Color.orange)

            if skills.isEmpty {
                Text(L10n("尚未登记任何 Skill，点「登记」从本地目录或 Git 仓库添加。"))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(skills) { skill in
                        let isSelected = selectedSkillIds.contains(skill.skillId)
                        Button {
                            if isSelected {
                                selectedSkillIds.remove(skill.skillId)
                            } else {
                                selectedSkillIds.insert(skill.skillId)
                            }
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(skill.manifestName ?? skill.name)
                                        .font(.callout)
                                    let summary = skill.manifestDescription ?? skill.description
                                    if !summary.isEmpty {
                                        Text(summary)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                                Text(skill.isGit ? "git" : L10n("本地"))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!isEnabled)
                        .padding(.vertical, 2)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
            }
        }
    }
}
