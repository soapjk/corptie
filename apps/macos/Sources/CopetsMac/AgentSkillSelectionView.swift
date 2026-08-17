import SwiftUI

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
