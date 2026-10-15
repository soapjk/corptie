import SwiftUI
import CorptieClientCore

/// Default delivery is typed business data and native business views. The old
/// node interpreter is reachable only on explicit unsupported-profile hosts.
public struct ConversationServerDetail<PlatformCard: View>: View {
    private let scope: String
    private let sessionID: String
    private let api: @Sendable () async throws -> ClientDetailAPI
    private let actions: ConversationDetailActions?
    private let coordinatorFactory: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)?
    private let onPresentationChanged: (Bool?) -> Void
    private let platformCardKinds: Set<String>
    private let platformCard: (String) -> PlatformCard
    @State private var store = ClientDetailBusinessStore()
    @State private var runtime = ConversationNativeBusinessActionRuntime()
    @State private var selected: ClientDetailAPI?
    @State private var legacy = false
    @State private var refreshing = false
    public init(scope: String, sessionID: String, actions: ConversationDetailActions? = nil,
                coordinator: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)? = nil,
                onPresentationChanged: @escaping (Bool?) -> Void = { _ in },
                platformCardKinds: Set<String>, @ViewBuilder platformCard: @escaping (String) -> PlatformCard,
                api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        self.scope = scope; self.sessionID = sessionID; self.actions = actions
        coordinatorFactory = coordinator; self.onPresentationChanged = onPresentationChanged; self.api = api
        self.platformCardKinds = platformCardKinds; self.platformCard = platformCard
    }
    public var body: some View {
        Group {
            if legacy {
                ConversationLegacyServerDetail(scope: scope, sessionID: sessionID, actions: actions,
                    coordinator: coordinatorFactory, onPresentationChanged: onPresentationChanged, api: api)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if let selected {
                        ConversationNativeBusinessDetail(store: store, api: selected, actions: actions,
                            platformCardKinds: platformCardKinds, platformCard: platformCard,
                            canCommand: { cardID, action in runtime.canPerform(cardID: cardID, action: action) },
                            perform: { cardID, action, fields in
                                runtime.perform(cardID: cardID, action: action, fields: fields, store: store, selected: selected, api: api)
                            })
                    }
                    if let message = store.error { Label(message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary) }
                    if let message = runtime.error { Text(message).font(.caption).foregroundStyle(.secondary) }
                    HStack {
                        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.plain).disabled(refreshing || selected == nil).help("刷新卡片").accessibilityLabel("刷新卡片")
                        if runtime.needsRecovery { Button("核对回执，不重发") { Task { await runtime.recover(store: store, selected: selected, api: api) } }.font(.caption) }
                    }
                }
            }
        }
        .task(id: scope) {
            store.begin(); runtime.retire(); selected = nil; legacy = false; onPresentationChanged(nil)
            var attempts = 0
            while !Task.isCancelled {
                do {
                    let current = try await api().nativeBusinessPolicy
                    let initial = try await current.businessSnapshot(sessionID: sessionID)
                    try Task.checkCancellation(); try store.receive(initial); selected = current; onPresentationChanged(true)
                    for try await document in current.businessSubscribe(sessionID: sessionID) {
                        try Task.checkCancellation(); try store.receive(document)
                    }
                    store.fail("连接中断，正在重新同步", clear: false)
                } catch is CancellationError { return }
                catch {
                    guard !Task.isCancelled else { return }
                    if let failure = error as? ClientServiceFailure {
                        if !store.selected && failure.statusCode == 409 && failure.code == "DETAIL_CATALOG_UNSUPPORTED" {
                            legacy = true; return
                        }
                        if [401, 403, 404].contains(failure.statusCode) { store.fail("访问已失效，请重新连接"); runtime.retire(); return }
                    }
                    store.fail("卡片暂不可用，正在重新连接")
                }
                attempts = min(attempts + 1, 4)
                do { try await Task.sleep(for: .seconds(1 << attempts)) } catch { return }
            }
        }
        .task(id: "\(scope):\(store.sessionID ?? ""):\(store.generation ?? "")") {
            runtime.retire()
            guard !legacy, let selected, let coordinatorFactory, let canonical = store.sessionID else { return }
            do {
                let coordinator = try await coordinatorFactory(selected, canonical)
                guard !Task.isCancelled else { try? await coordinator.invalidate(clearRecoveryIdentity: false); return }
                runtime.install(coordinator)
                await runtime.recover(store: store, selected: selected, api: api)
            } catch { if !Task.isCancelled { runtime.error = "操作暂不可用，未发送" } }
        }
        .confirmationDialog(runtime.confirmation?.label.fallback ?? "确认操作", isPresented: Binding(
            get: { runtime.confirmation != nil }, set: { if !$0 { runtime.confirm(false) } }), titleVisibility: .visible) {
            Button("确认", role: runtime.confirmation?.confirmation == "destructive" ? .destructive : nil) { runtime.confirm(true) }
            Button("取消", role: .cancel) { runtime.confirm(false) }
        }
        .onDisappear { runtime.retire(); onPresentationChanged(nil) }
    }
    private func refresh() async {
        guard !refreshing, let selected else { return }; refreshing = true
        defer { refreshing = false }
        do {
            let next = try await api().businessSnapshot(sessionID: store.sessionID ?? sessionID)
            try Task.checkCancellation(); try store.receive(next, resetPages: true)
        } catch { if !Task.isCancelled { store.fail("刷新未完成，请稍后重试") } }
        _ = selected
    }
}
