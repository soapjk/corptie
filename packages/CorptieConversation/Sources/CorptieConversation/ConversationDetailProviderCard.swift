import SwiftUI
import CorptieClientCore

/// Complete shared controls, not platform-supplied View slots.
public struct ConversationDetailProviderCard: View {
    let configuration: ClientDetailConfiguration
    let scope: String
    let select: @MainActor (ClientDetailConfiguration.Field, String) async throws -> Void
    let reload: @MainActor () async -> Void
    @State private var pending: ClientDetailConfiguration.Choice?
    @State private var submitting = false
    @State private var error: String?
    @State private var lifetime = UUID()
    public init(configuration: ClientDetailConfiguration, scope: String,
                select: @escaping @MainActor (ClientDetailConfiguration.Field, String) async throws -> Void,
                reload: @escaping @MainActor () async -> Void) {
        self.configuration = configuration; self.scope = scope; self.select = select; self.reload = reload
    }
    public var body: some View {
        ConversationDetailModuleCard(title: "Provider", systemImage: "cpu", headerActions: {
            Button { Task { await reload() } } label: { ConversationDetailHeaderIcon(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).disabled(submitting || configuration.busy).help("刷新配置").accessibilityLabel("刷新配置")
        }) {
            selector(.provider, label: "Provider")
            selector(.model, label: "模型")
            selector(.reasoning, label: "处理强度")
            if submitting || configuration.busy { Label("正在更新配置…", systemImage: "clock").font(.caption).foregroundStyle(.secondary) }
            if let message = error ?? configuration.error { Text(message).font(.caption).foregroundStyle(.secondary) }
        }
        .confirmationDialog("切换 Provider？", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            if let target = pending {
                Button("切换") { pending = nil; submit(.provider, target.id) }
                Button("取消", role: .cancel) { pending = nil }
            }
        } message: {
            Text("将从 \(configuration.provider.title) 切换到 \(pending?.title ?? "所选 Provider")。现有聊天记录和工作空间会保留，系统将建立新的 Provider 线程。")
        }
        .onChange(of: scope) { _, _ in lifetime = UUID(); pending = nil; submitting = false; error = nil }
        .onChange(of: configuration.provider.id) { _, _ in pending = nil; error = nil }
        .onDisappear { lifetime = UUID(); pending = nil }
    }
    private func selector(_ field: ClientDetailConfiguration.Field, label: String) -> some View {
        let value = configuration.selection(field)
        return LabeledContent(label) {
            Menu {
                ForEach(value.choices) { choice in
                    Button {
                        if field == .provider { pending = choice } else { submit(field, choice.id) }
                    } label: {
                        if choice.id == value.id { Label(choice.title, systemImage: "checkmark") } else { Text(choice.title) }
                    }.disabled(!choice.available || choice.id == value.id)
                }
            } label: {
                HStack(spacing: 6) {
                    Text(value.title.isEmpty ? "未设置" : value.title).lineLimit(1)
                    if value.canSelect { Image(systemName: "chevron.up.chevron.down").font(.caption2) }
                }.foregroundStyle(value.canSelect ? Color.accentColor : Color.secondary).frame(minHeight: 28).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .disabled(!value.canSelect || value.choices.isEmpty || submitting || configuration.busy)
            .accessibilityLabel("切换\(label)")
        }.font(.caption)
    }
    private func submit(_ field: ClientDetailConfiguration.Field, _ id: String) {
        let value = configuration.selection(field)
        guard !submitting, !configuration.busy, value.canSelect,
              value.choices.contains(where: { $0.id == id && $0.available }), value.id != id else { return }
        let token = lifetime
        submitting = true; error = nil
        Task { @MainActor in
            do { try await select(field, id) }
            catch { if lifetime == token { self.error = error.localizedDescription } }
            if lifetime == token { submitting = false }
        }
    }
}
