import SwiftUI
import CorptieClientCore

/// One native interaction surface on all three clients. It only prepares
/// existing reviewed Jobs; no Git commands or fabricated test results here.
public struct ConversationHierarchyActions: View {
    private let hierarchy: WorktreeHierarchy
    private let api: @MainActor () async throws -> ClientTaskHierarchyAPI
    private let prepare: @MainActor (String, String?) async -> Void
    private let localize: (String) -> String
    private let openParent: ((String) -> Void)?
    @State private var activeScope: String?
    private var scopeID: String { "\(hierarchy.rootTaskId):\(hierarchy.hierarchyRevision):\(hierarchy.bindingRevision)" }
    public init(hierarchy: WorktreeHierarchy, api: @escaping @MainActor () async throws -> ClientTaskHierarchyAPI,
                prepare: @escaping @MainActor (String,String?) async -> Void,
                openParent: ((String) -> Void)? = nil,
                localize: @escaping (String)->String = {$0}) {
        self.hierarchy=hierarchy; self.api=api; self.prepare=prepare; self.openParent=openParent; self.localize=localize
    }
    public var body: some View {
        VStack(alignment:.leading,spacing:8) {
            Text("\(localize(hierarchy.role == "child" ? "父分支" : "主分支")): \(hierarchy.comparison.branchName ?? "—")")
                .font(.caption).foregroundStyle(.secondary)
            if hierarchy.role == "child" {
                if let state=hierarchy.changeState {
                    Text(localize(state == "no_changes" ? "无代码改动" : state == "history_only" ? "仅提交历史变化" : state == "code_changes" ? "存在代码改动" : "工作区状态需要检查"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                operation("合并到父分支","merge_children",hierarchy.actions.mergeToParent)
                operation("同步父分支","sync_children",hierarchy.actions.syncFromParent)
            } else {
                Text("\(hierarchy.integratedChildCount ?? 0)/\(hierarchy.childCount) \(localize("子分支已合入"))").font(.caption)
                operation("合并所有子分支","merge_children",hierarchy.actions.mergeChildren)
                operation("所有子分支同步父分支","sync_children",hierarchy.actions.syncChildren)
                operation("同步主分支","sync_main",hierarchy.actions.syncFromMain)
                Divider()
                ConversationIntegrationAcceptance(taskID: hierarchy.rootTaskId, api: api, openParent: openParent, localize: localize) { status in
                    Button(localize("合并到主分支")) { Task { await prepare("promote_parent",status?.receiptId) } }
                        .disabled(status?.mayPromote != true)
                }
                .id(scopeID)
            }
        }.disabled(activeScope != scopeID)
        .task(id:scopeID) {
            activeScope=scopeID
        }
        .onDisappear { activeScope=nil }
    }
    private func operation(_ label: String,_ action: String,_ capability: TaskHierarchyAction)->some View {
        Button(localize(label)) { Task { await prepare(action,nil) } }.disabled(!capability.available)
            .help(capability.reason ?? "").accessibilityHint(capability.reason ?? "")
    }
}
