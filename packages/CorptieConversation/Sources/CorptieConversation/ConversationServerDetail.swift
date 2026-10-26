import SwiftUI
import CorptieClientCore

/// Default delivery is typed business data and native business views. The old
/// node interpreter is reachable only on explicit unsupported-profile hosts.
public struct ConversationServerDetail: View {
    private let scope: String
    private let sessionID: String
    private let context: ClientDetailContext
    private let api: @Sendable () async throws -> ClientDetailAPI
    private let actions: ConversationDetailActions?
    private let coordinatorFactory: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)?
    private let onPresentationChanged: (Bool?) -> Void
    private let adapters: ConversationDetailAdapters
    private let repository: ClientDetailBusinessRepository
    private let handle: ClientDetailBusinessHandle
    private let presentation: ConversationDetailPresentation
    private var store: ClientDetailBusinessStore { handle.store }
    @State private var runtime = ConversationNativeBusinessActionRuntime()
    @State private var selected: ClientDetailAPI?
    @State private var refreshing = false
    public init(scope: String, sessionID: String, context: ClientDetailContext, actions: ConversationDetailActions? = nil,
                coordinator: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)? = nil,
                onPresentationChanged: @escaping (Bool?) -> Void = { _ in },
                repository: ClientDetailBusinessRepository, displayScope: ClientDetailBusinessScope,
                presentationRepository: ConversationDetailPresentationRepository,
                adapters: ConversationDetailAdapters,
                api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        self.scope = scope; self.sessionID = sessionID; self.context = context; self.actions = actions
        coordinatorFactory = coordinator; self.onPresentationChanged = onPresentationChanged; self.api = api
        self.adapters = adapters
        self.repository = repository; self.handle = repository.entry(for: displayScope)
        self.presentation = presentationRepository.entry(for: displayScope)
    }
    public var body: some View {
        Group {
            if handle.legacy {
                ConversationLegacyServerDetail(scope: scope, sessionID: sessionID, actions: actions,
                    coordinator: coordinatorFactory, onPresentationChanged: onPresentationChanged, api: api)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if !store.order.isEmpty {
                        if !store.isCurrent && store.loadPhase != .failed {
                            Text("正在校验上次详情，操作暂不可用").font(.caption).foregroundStyle(.secondary)
                        }
                        ConversationNativeBusinessDetail(store: store, api: selected, actions: store.isCurrent ? actions : nil, context: context,
                            adapters: adapters, handle: handle, arrangement: presentation.arrangement, arranging: false, refresh: refresh,
                            canCommand: { cardID, action in store.isCurrent && runtime.canPerform(cardID: cardID, action: action) },
                            perform: { cardID, action, fields in
                                guard let selected else { return }
                                runtime.perform(cardID: cardID, action: action, fields: fields, store: store, selected: selected, api: api)
                            })
                    } else if !handle.retired {
                        ConversationDetailResidentPreview(value: adapters.resident)
                        if store.loadPhase == .loading || store.loadPhase == .idle {
                            ProgressView("正在同步其余详情…").font(.caption)
                        }
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
        .environment(\.detailPresentation, presentation)
        .task(id: handle.scope) {
            runtime.retire(); selected = nil
            let lease = repository.acquire(handle, api: api)
            defer { repository.release(lease, from: handle) }
            do { selected = try await api().nativeBusinessPolicy } catch { /* Feed owns authenticated retry. */ }
            for await _ in lease.updates {
                guard !Task.isCancelled else { return }
                if !handle.legacy && store.selected { onPresentationChanged(true) }
            }
        }
        .task(id: "\(scope):\(store.sessionID ?? ""):\(store.generation ?? ""):\(store.isCurrent):\(selected != nil)") {
            runtime.retire()
            guard !handle.legacy, store.isCurrent, !handle.retired, let selected, let coordinatorFactory, let canonical = store.sessionID else { return }
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
        .onDisappear { runtime.retire(); selected = nil }
    }
    private func refresh() async {
        guard !refreshing, let selected else { return }; refreshing = true
        store.markRefreshing()
        defer { refreshing = false }
        do {
            let next = try await api().businessSnapshot(sessionID: store.sessionID ?? sessionID)
            try Task.checkCancellation(); try store.receive(next, resetPages: true)
            repository.resumeIfNeeded(handle, api: api)
        } catch {
            guard !Task.isCancelled else { return }
            if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
                store.fail("访问已失效，请重新连接", disposition: .accessRevoked); runtime.retire()
            } else { store.fail("刷新未完成，已保留上次内容", disposition: .temporary) }
        }
        _ = selected
    }
}
