import SwiftUI
import CorptieClientCore

/// One native interaction surface on all three clients. It only prepares
/// existing reviewed Jobs; no Git commands or fabricated test results here.
public struct ConversationHierarchyActions: View {
    private let hierarchy: WorktreeHierarchy
    private let api: @MainActor () async throws -> ClientTaskHierarchyAPI
    private let prepare: @MainActor (String, String?) async -> Void
    private let localize: (String) -> String
    @State private var acceptance: TaskIntegrationAcceptanceStatus?
    @State private var snapshot: TaskIntegrationSnapshot?
    @State private var busy=false
    @State private var failure: String?
    @State private var activeScope: String?
    @State private var requestToken = UUID()
    private var scopeID: String { "\(hierarchy.rootTaskId):\(hierarchy.hierarchyRevision):\(hierarchy.bindingRevision)" }
    public init(hierarchy: WorktreeHierarchy, api: @escaping @MainActor () async throws -> ClientTaskHierarchyAPI,
                prepare: @escaping @MainActor (String,String?) async -> Void,
                localize: @escaping (String)->String = {$0}) {
        self.hierarchy=hierarchy; self.api=api; self.prepare=prepare; self.localize=localize
    }
    public var body: some View {
        VStack(alignment:.leading,spacing:8) {
            Text("\(localize(hierarchy.role == "child" ? "父分支" : "主分支")): \(hierarchy.comparison.branchName ?? "—")")
                .font(.caption).foregroundStyle(.secondary)
            if hierarchy.role == "child" {
                operation("合并到父分支","merge_children",hierarchy.actions.mergeToParent)
                operation("同步父分支","sync_children",hierarchy.actions.syncFromParent)
            } else {
                Text("\(hierarchy.integratedChildCount ?? 0)/\(hierarchy.childCount) \(localize("子分支已合入"))").font(.caption)
                operation("合并所有子分支","merge_children",hierarchy.actions.mergeChildren)
                operation("所有子分支同步父分支","sync_children",hierarchy.actions.syncChildren)
                operation("同步主分支","sync_main",hierarchy.actions.syncFromMain)
                Divider()
                HStack {
                    Text(localize(acceptance?.state == "passed" ? "集成验证已通过" : acceptance?.state == "stale" ? "集成验证已过期" : "尚未提交集成验证"))
                    Spacer()
                    Button { Task { await reload() } } label: { Image(systemName:"arrow.clockwise") }
                        .accessibilityLabel(localize("刷新验收状态"))
                }.font(.caption)
                Button(localize("准备验收版本")) { Task { await capture() } }
                if let snapshot {
                    Text("\(localize("待验证提交")): \(snapshot.parentHeadOid.prefix(10))").font(.caption.monospaced()).textSelection(.enabled)
                    Text(snapshot.snapshotId).font(.caption2.monospaced()).textSelection(.enabled)
                    Text(localize("请在父会话执行测试并报告该快照的验证证据。准备版本不表示测试已通过。"))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let reason=acceptance?.reason { Text(reason).font(.caption2).foregroundStyle(.secondary) }
                Button(localize("验收后合入主分支")) { Task { await prepare("promote_parent",acceptance?.receiptId) } }
                    .disabled(acceptance?.canPromote != true)
            }
            if let failure { Text(failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }.disabled(busy || activeScope != scopeID)
        .task(id:scopeID) {
            activeScope=scopeID; requestToken=UUID(); busy=false
            acceptance=nil; snapshot=nil; failure=nil
            if hierarchy.role == "parent" { await reload() }
        }
        .onDisappear { activeScope=nil; requestToken=UUID() }
    }
    private func operation(_ label: String,_ action: String,_ capability: TaskHierarchyAction)->some View {
        Button(localize(label)) { Task { await prepare(action,nil) } }.disabled(!capability.available)
            .help(capability.reason ?? "").accessibilityHint(capability.reason ?? "")
    }
    @MainActor private func reload() async {
        let token=UUID(), scope=scopeID
        requestToken=token; busy=true
        defer { if requestToken == token { busy=false } }
        do {
            let result=try await api().acceptance(taskID:hierarchy.rootTaskId)
            guard !Task.isCancelled, requestToken == token, activeScope == scope else { return }
            acceptance=result; failure=nil
        } catch {
            guard !Task.isCancelled, requestToken == token, activeScope == scope else { return }
            failure=error.localizedDescription
        }
    }
    @MainActor private func capture() async {
        let token=UUID(), scope=scopeID
        requestToken=token; busy=true
        defer { if requestToken == token { busy=false } }
        do {
            let result=try await api().captureIntegrationSnapshot(taskID:hierarchy.rootTaskId,requestID:UUID().uuidString,
                revision:hierarchy.hierarchyRevision,bindingRevision:hierarchy.bindingRevision)
            guard !Task.isCancelled, requestToken == token, activeScope == scope else { return }
            snapshot=result; failure=nil
        } catch {
            guard !Task.isCancelled, requestToken == token, activeScope == scope else { return }
            failure=error.localizedDescription
        }
    }
}
