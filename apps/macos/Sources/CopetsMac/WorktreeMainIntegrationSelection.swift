import SwiftUI

struct WorktreeMainIntegrationSelection: View {
    let worktrees: [ManagedWorktree]
    let onChoose: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []

    private var sources: [ManagedWorktree] { worktrees.filter { !$0.isMain } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Choose Worktrees to Merge into main")).font(.title2.weight(.semibold))
            Text(L10n("Choose any subset. Parent and child dependencies will be shown in the next review before anything runs."))
                .foregroundStyle(.secondary)
            HStack {
                Button(L10n("Select All")) { selected = Set(sources.map(\.worktreeId)) }
                Button(L10n("Clear Selection")) { selected.removeAll() }
            }
            List(sources) { tree in
                Toggle(isOn: Binding(get: { selected.contains(tree.worktreeId) }, set: { value in
                    if value { selected.insert(tree.worktreeId) } else { selected.remove(tree.worktreeId) }
                })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(tree.branchName ?? tree.path)
                        if let hierarchy = tree.hierarchy {
                            Text(hierarchy.role == "child"
                                 ? L10n("Child delivery — includes parent and sibling dependencies")
                                 : L10nFormat("Parent delivery · %d child task(s)", hierarchy.childCount))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .toggleStyle(.checkbox)
                .accessibilityIdentifier("worktree.integrate.select.\(tree.worktreeId)")
            }
            HStack {
                Button(L10n("Cancel"), role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(L10n("Review Integration Plan")) {
                    onChoose(selected.sorted())
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(selected.isEmpty)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 640, height: 520)
        .onAppear {
            selected = Set(sources.filter { $0.pendingIntegration == true }.map(\.worktreeId))
        }
    }
}

struct WorktreeIntegrationStepsView: View {
    let steps: [WorktreeIntegrationGraphStep]

    var body: some View {
        DisclosureGroup(L10n("Integration Steps")) {
            ForEach(steps) { step in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: symbol(for: step.status))
                        .foregroundStyle(step.status == "completed" ? Color.green : Color.secondary)
                        .accessibilityLabel(L10n(step.status ?? "pending"))
                    Text(step.label).textSelection(.enabled)
                }
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
            }
        }
        .accessibilityIdentifier("worktree.integrate.steps")
    }

    private func symbol(for status: String?) -> String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "running": "arrow.triangle.merge"
        case "waiting": "pause.circle"
        default: "circle"
        }
    }
}
