import SwiftUI
import AppKit

// Skill 登记弹层：把一个新的 Skill 加入全局 Skill 维护中心。
// 支持两种来源：本地目录（含 SKILL.md）或 Git 仓库 URL（含 SKILL.md）。
// 登记成功后回调 skill（用于立即勾选预装）。

struct SkillRegisterView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    /// 登记成功后回调；取消或失败时回调 nil。
    var onRegistered: (Skill?) -> Void

    @State private var sourceType = "local"
    @State private var localPath = ""
    @State private var gitURL = ""
    @State private var name = ""
    @State private var description = ""
    @State private var isBusy = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("登记 Skill"))
                .font(.title3.bold())

            Picker(L10n("来源"), selection: $sourceType) {
                Text(L10n("本地目录")).tag("local")
                Text(L10n("Git 仓库")).tag("git")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 320, alignment: .leading)

            if sourceType == "local" {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("本地目录（需含 SKILL.md）"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack {
                        TextField(L10n("选择包含 SKILL.md 的目录"), text: $localPath)
                            .textFieldStyle(.roundedBorder)
                        Button(L10n("浏览…")) { chooseDirectory() }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Git 仓库 URL（需含 SKILL.md）"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("https://github.com/user/skill-repo.git", text: $gitURL)
                        .textFieldStyle(.roundedBorder)
                }
            }

            field(L10n("名称（可选）")) {
                TextField(L10n("留空则自动推断"), text: $name)
            }
            field(L10n("描述（可选）")) {
                TextField(L10n("这个 Skill 做什么"), text: $description)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }

            HStack {
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("登记")) { register() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isBusy || !canSubmit)
            }
        }
        .padding(24)
        .frame(width: 460)
    }

    private var canSubmit: Bool {
        sourceType == "local"
            ? !localPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            : !gitURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "选择包含 SKILL.md 的目录"
        panel.prompt = "选择"
        if panel.runModal() == .OK, let url = panel.url {
            localPath = url.path
        }
    }

    private func register() {
        let source = sourceType == "local"
            ? localPath.trimmingCharacters(in: .whitespacesAndNewlines)
            : gitURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else { return }

        isBusy = true
        errorMessage = nil
        Task {
            let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedDesc = description.trimmingCharacters(in: .whitespacesAndNewlines)
            let skill = await client.registerSkill(
                name: trimmedName.isEmpty ? nil : trimmedName,
                description: trimmedDesc.isEmpty ? nil : trimmedDesc,
                sourceType: sourceType,
                source: source
            )
            isBusy = false
            if let skill {
                onRegistered(skill)
                dismiss()
            } else {
                errorMessage = client.errorMessage ?? "登记失败。"
            }
        }
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
