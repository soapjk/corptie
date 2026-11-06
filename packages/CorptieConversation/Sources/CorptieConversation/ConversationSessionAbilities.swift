import SwiftUI
import CorptieClientCore

/// Session-local state; no global observation or list-wide entity refresh.
public struct ConversationSessionAbilities: View {
    private struct Row: Identifiable {
        let id: String
        let kind: String
        let name: String
        let disabled: Bool
        let available: Bool
    }
    private let scope: String
    private let refreshKey: String
    private let read: () async throws -> ClientInspectorValue
    private let update: ([String: ClientInspectorValue], String) async throws -> Void
    @State private var rows: [Row] = []
    @State private var preview: [Row] = []
    @State private var version: Double = 0
    @State private var loaded = false
    @State private var expanded = false
    @State private var showAll = false
    @State private var pending = false
    @State private var error: String?

    public init(scope: String, refreshKey: String = "", read: @escaping () async throws -> ClientInspectorValue,
                update: @escaping ([String: ClientInspectorValue], String) async throws -> Void) {
        self.scope = scope; self.refreshKey = refreshKey; self.read = read; self.update = update
    }

    public var body: some View {
        DisclosureGroup("技能与工具", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                Text("仅影响当前会话，不修改角色或其他会话。")
                    .font(.caption).foregroundStyle(.secondary)
                if !loaded { ProgressView("正在读取配置…") }
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(showAll ? rows : preview) { row in
                        Toggle(isOn: Binding(get: { !row.disabled }, set: { enabled in
                            Task { await submit(["kind": .string(row.kind), "id": .string(row.id), "disabled": .bool(!enabled)]) }
                        })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.name)
                                Text("\(row.kind == "skill" ? "Skill" : "MCP") · \(!row.available ? "默认配置不可用" : row.disabled ? "此会话已禁用" : "继承角色默认")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(!loaded || pending || (!row.available && row.disabled))
                        .accessibilityIdentifier("session.ability.\(row.id)")
                    }
                }
                if rows.count > preview.count && !showAll {
                    Button("显示全部 \(rows.count) 项") { showAll = true }
                }
                if loaded && rows.isEmpty { Text("角色未分配可选能力").font(.caption) }
                if pending { ProgressView("正在保存并核对…") }
                if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
                HStack {
                    Button("刷新") { Task { await reload() } }
                    Button("恢复角色默认") { Task { await submit(["reset": .bool(true)]) } }
                }.disabled(pending)
                Text("MCP 阻止后续调用；Skill 停止 Corptie 后续提供与加载。当前尚不支持 Provider 原生共享 Skill 目录的会话级隔离；已进入历史的内容无法撤回，正在执行的调用不会强制取消。")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
        }
        .task(id: "\(scope):\(refreshKey)") { await reload() }
    }

    @MainActor private func reload() async {
        do {
            let value = try await read()
            try Task.checkCancellation()
            rows = value["abilities"].items.compactMap { item in
                guard let id = item["id"].text, let kind = item["kind"].text else { return nil }
                return Row(id: id, kind: kind, name: item["name"].text ?? id,
                    disabled: item["disabled"].flag, available: item["available"].flag)
            }
            preview = Array(rows.prefix(8))
            version = value["resourceVersion"].number ?? 0
            loaded = true; error = nil
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }

    @MainActor private func submit(_ fields: [String: ClientInspectorValue]) async {
        guard loaded, !pending else { return }
        pending = true; error = nil
        defer { pending = false }
        do {
            var input = fields; input["expectedResourceVersion"] = .number(version)
            try await update(input, UUID().uuidString)
            await reload()
        } catch {
            loaded = false
            self.error = "未确认更新结果，请刷新核对后再操作。\(error.localizedDescription)"
        }
    }
}
