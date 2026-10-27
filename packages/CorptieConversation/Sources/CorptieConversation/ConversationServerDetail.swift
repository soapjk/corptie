import SwiftUI
import Observation
import CorptieClientCore

/// A synchronous action fence; hiding an AppKit view alone does not cancel SwiftUI tasks.
@MainActor @Observable
public final class ConversationDetailPresentationActivity {
    public private(set) var isActive: Bool
    public private(set) var generation: UInt64 = 0
    @ObservationIgnored private weak var renderState: ConversationDetailRenderState?
    @ObservationIgnored private var actionsEnabled: Bool
    public init(isActive: Bool = false) { self.isActive = isActive; actionsEnabled = isActive }
    func bind(renderState: ConversationDetailRenderState) { self.renderState = renderState }
    public func suspendActions() { actionsEnabled = false; renderState?.freeze() }
    public func activate() {
        actionsEnabled = true
        if !isActive { generation &+= 1; isActive = true }
        renderState?.resumeIfBound()
    }
    public func deactivate() { suspendActions(); guard isActive else { return }; isActive = false; generation &+= 1 }
    public func allows(generation: UInt64) -> Bool { actionsEnabled && isActive && self.generation == generation }
}

/// Default delivery is typed business data and native business views. The old
/// node interpreter is reachable only on explicit unsupported-profile hosts.
public struct ConversationServerDetail: View {
    private let activity: ConversationDetailPresentationActivity?
    private var isPresentationActive: Bool { activity?.isActive ?? true }
    private func allows(_ generation: UInt64) -> Bool { activity?.allows(generation: generation) ?? true }
    private struct FeedTaskID: Equatable { let scope: ClientDetailBusinessScope?; let generation: UInt64 }
    private var feedTaskID: FeedTaskID { .init(scope: isPresentationActive ? handle.scope : nil, generation: activity?.generation ?? 0) }
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
    @State private var renderState: ConversationDetailRenderState? = nil
    private var displayStore: ClientDetailBusinessStore { renderState?.store ?? store }
    private var displayLegacy: Bool { renderState?.legacy ?? handle.legacy }
    private var displayRetired: Bool { renderState?.retired ?? handle.retired }
    @State private var runtime = ConversationNativeBusinessActionRuntime()
    @State private var selected: ClientDetailAPI?
    @State private var refreshing = false
    public init(scope: String, sessionID: String, context: ClientDetailContext, actions: ConversationDetailActions? = nil,
                coordinator: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)? = nil,
                onPresentationChanged: @escaping (Bool?) -> Void = { _ in },
                repository: ClientDetailBusinessRepository, displayScope: ClientDetailBusinessScope,
                presentationRepository: ConversationDetailPresentationRepository,
                adapters: ConversationDetailAdapters,
                activity: ConversationDetailPresentationActivity? = nil,
                api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        self.activity = activity
        self.scope = scope; self.sessionID = sessionID; self.context = context; self.actions = actions
        coordinatorFactory = coordinator; self.onPresentationChanged = onPresentationChanged; self.api = api
        self.adapters = adapters
        self.repository = repository; self.handle = repository.entry(for: displayScope)
        self.presentation = presentationRepository.entry(for: displayScope)
    }
    public var body: some View {
        Group {
            if activity != nil && renderState == nil {
                // Materialize the value copies once in the lifecycle task,
                // never eagerly allocate stores on every parent body update.
                ConversationDetailResidentPreview(value: adapters.resident)
            } else if displayLegacy {
                ConversationLegacyServerDetail(scope: scope, sessionID: sessionID, actions: actions,
                    coordinator: coordinatorFactory, onPresentationChanged: onPresentationChanged, api: api)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if !displayStore.order.isEmpty {
                        if !displayStore.isCurrent && displayStore.loadPhase != .failed {
                            Text("正在校验上次详情，操作暂不可用").font(.caption).foregroundStyle(.secondary)
                        }
                        ConversationNativeBusinessDetail(store: displayStore, commandStore: store, api: selected, actions: displayStore.isCurrent && isPresentationActive ? actions : nil, context: context,
                            adapters: adapters, handle: handle, arrangement: presentation.arrangement, refresh: refresh,
                            renderState: activity == nil ? nil : renderState, activity: activity,
                            canCommand: { cardID, action in isPresentationActive && !displayRetired && displayStore.isCurrent && runtime.canPerform(cardID: cardID, action: action) },
                            perform: { cardID, action, fields in
                                guard allows(activity?.generation ?? 0), !handle.retired, store.isCurrent, let selected else { return }
                                runtime.perform(cardID: cardID, action: action, fields: fields, store: store, selected: selected, api: api)
                            })
                    } else if !displayRetired {
                        ConversationDetailResidentPreview(value: adapters.resident)
                        if displayStore.loadPhase == .loading || displayStore.loadPhase == .idle {
                            ProgressView("正在同步其余详情…").font(.caption)
                        }
                    }
                    if let message = displayStore.error { Label(message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary) }
                    if let message = runtime.error { Text(message).font(.caption).foregroundStyle(.secondary) }
                    HStack {
                        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.plain).disabled(refreshing || selected == nil).help("刷新卡片").accessibilityLabel("刷新卡片")
                        if runtime.needsRecovery { Button("核对回执，不重发") { Task { guard allows(activity?.generation ?? 0) else { return }; await runtime.recover(store: store, selected: selected, api: api) } }.font(.caption) }
                    }
                }
            }
        }
        .environment(\.detailPresentation, presentation)
        .task(id: feedTaskID) {
            deactivatePresentation()
            guard isPresentationActive, !handle.retired else { renderState?.freeze(); return }
            if activity != nil {
                if renderState == nil { renderState = ConversationDetailRenderState() }
                if let renderState { activity?.bind(renderState: renderState); renderState.resume(from: handle) }
            }
            let generation = activity?.generation ?? 0
            let lease = repository.acquire(handle, api: api)
            defer { repository.release(lease, from: handle) }
            do {
                let policy = try await api().nativeBusinessPolicy
                guard !Task.isCancelled, allows(generation), !handle.retired else { return }
                selected = policy
            } catch { /* Feed owns authenticated retry. */ }
            for await _ in lease.updates {
                guard !Task.isCancelled, allows(generation), !handle.retired else { return }
                if !handle.legacy && store.selected { onPresentationChanged(true) }
            }
        }
        .task(id: coordinatorTaskID) {
            runtime.retire()
            let generation = activity?.generation ?? 0
            guard isPresentationActive, !handle.legacy, store.isCurrent, !handle.retired, let selected, let coordinatorFactory, let canonical = store.sessionID else { return }
            do {
                let coordinator = try await coordinatorFactory(selected, canonical)
                guard !Task.isCancelled, allows(generation), !handle.retired, store.isCurrent else { try? await coordinator.invalidate(clearRecoveryIdentity: false); return }
                runtime.install(coordinator)
                await runtime.recover(store: store, selected: selected, api: api)
            } catch { if !Task.isCancelled && allows(generation) { runtime.error = "操作暂不可用，未发送" } }
        }
        .confirmationDialog(runtime.confirmation?.label.fallback ?? "确认操作", isPresented: Binding(
            get: { runtime.confirmation != nil }, set: { if !$0 { runtime.confirm(false) } }), titleVisibility: .visible) {
            Button("确认", role: runtime.confirmation?.confirmation == "destructive" ? .destructive : nil) { guard isPresentationActive, !handle.retired, store.isCurrent else { runtime.confirm(false); return }; runtime.confirm(true) }
            Button("取消", role: .cancel) { runtime.confirm(false) }
        }
        .onChange(of: isPresentationActive) { _, active in if !active { deactivatePresentation() } }
        .onDisappear { deactivatePresentation() }
    }
    private var coordinatorTaskID: String {
        // A cold controlled root must not observe the original mutable store
        // before its presentation copies exist (including initially hidden roots).
        let displayed: ClientDetailBusinessStore? = activity == nil ? store : renderState?.store
        return "\(isPresentationActive):\(activity?.generation ?? 0):\(scope):\(displayed?.sessionID ?? ""):\(displayed?.generation ?? ""):\(displayed?.isCurrent ?? false):\(selected != nil)"
    }
    private func deactivatePresentation() { renderState?.freeze(); runtime.retire(); selected = nil }
    private func refresh() async {
        let generation = activity?.generation ?? 0
        guard isPresentationActive, !handle.retired, !refreshing, let selected else { return }; refreshing = true
        store.markRefreshing()
        defer { refreshing = false }
        do {
            let next = try await api().businessSnapshot(sessionID: store.sessionID ?? sessionID)
            try Task.checkCancellation(); guard allows(generation), !handle.retired else { return }; try store.receive(next, resetPages: true)
            repository.resumeIfNeeded(handle, api: api)
        } catch {
            guard !Task.isCancelled, allows(generation), !handle.retired else { return }
            if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
                store.fail("访问已失效，请重新连接", disposition: .accessRevoked); runtime.retire()
            } else { store.fail("刷新未完成，已保留上次内容", disposition: .temporary) }
        }
        _ = selected
    }
}
