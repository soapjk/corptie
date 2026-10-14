import SwiftUI
import CorptieClientCore

/// Incrementally migrated modules share this exact renderer on all three clients.
/// Existing resource/editor modules remain outside until their action contracts migrate.
public struct ConversationServerDetail: View {
    private let scope: String
    private let sessionID: String
    private let api: @Sendable () async throws -> ClientDetailAPI
    private let platformActions: ConversationDetailActions?
    private let onPresentationChanged: (Bool?) -> Void
    private let coordinatorFactory: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)?
    @State private var actionRuntime = ConversationDetailActionRuntime()
    @State private var store = ClientDetailStore()
    @State private var refreshing = false
    @State private var presentationAPI: ClientDetailAPI?
    // These five nodes have a native read-only implementation on all clients.
    // No button/form/image resolver or command is implied by registration.
    private static let readCapabilities = ["detail.dateTime", "detail.keyValue", "detail.markdown", "detail.resourceList", "detail.status"]

    public init(scope: String, sessionID: String, actions: ConversationDetailActions? = nil,
                coordinator: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)? = nil,
                onPresentationChanged: @escaping (Bool?) -> Void = { _ in },
                api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        self.scope = scope; self.sessionID = sessionID; self.api = api; self.platformActions = actions; self.coordinatorFactory = coordinator
        self.onPresentationChanged = onPresentationChanged
    }
    private var presentsRichDocument: Bool? {
        guard let presentationAPI else { return nil }
        guard presentationAPI.negotiation.catalog == "native-v2-components-1" else { return false }
        return store.documentID != nil && !store.orderedCards.isEmpty ? true : nil
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ConversationDetailRenderer(store: store, refreshing: refreshing, actions: .init(canPerform: { action in
                action.kind == "read" && action.operation == "detail.refresh" && !refreshing
                    || actionRuntime.canPerform(action, writes: presentationAPI?.writesAvailable == true)
                    || platformActions?.canPerform(action) == true
            }, perform: { action, fields in
                    if action.kind != "read" || action.operation != "detail.refresh" {
                        guard platformActions?.canPerform(action) == true else { return }
                        platformActions?.perform(action, fields); return
                    }
                    // Fail closed: this catalog currently registers only a read-only refresh.
                    guard action.kind == "read", action.operation == "detail.refresh", !refreshing else { return }
                    refreshing = true
                    Task {
                        defer { refreshing = false }
                        guard let presentationAPI else { return }
                        let factory = api
                        await store.refresh(sessionID: sessionID, api: { try await factory().usingPresentationPolicy(presentationAPI) })
                    }
            }, resolveImage: platformActions?.resolveImage, performInCard: { cardID, action, fields in
                if action.kind == "navigation" {
                    guard platformActions?.canPerform(action) == true else { return }
                    platformActions?.perform(action, fields)
                } else if action.operation == "detail.refresh" {
                    guard !refreshing, let selected = presentationAPI else { return }
                    refreshing = true; let factory = api
                    Task { defer { refreshing = false }; await store.refresh(sessionID: sessionID, api: { try await factory().usingPresentationPolicy(selected) }) }
                } else if let selected = presentationAPI {
                    actionRuntime.perform(cardID: cardID, action: action, fields: fields, store: store, selected: selected, api: api)
                }
            }, canPerformInCard: { cardID, action in actionRuntime.isIdle(cardID: cardID, actionID: action.id) }))
            if let error = store.error { Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary) }
            if let error = actionRuntime.error { Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary) }
            if actionRuntime.needsRecovery, let selected = presentationAPI {
                Button("核对回执（不重发）") { Task { await actionRuntime.recover(store: store, selected: selected, api: api) } }
            }
        }
        .task(id: scope) {
            presentationAPI = nil
            store.beginPresentation(scope: scope)
            do {
                let configured = try await api().forPresentation(sessionID: sessionID,
                    clientCapabilities: Self.readCapabilities + (coordinatorFactory != nil ? ["detail.button", "detail.form"] : platformActions == nil ? [] : ["detail.button"]))
                guard !Task.isCancelled else { return }
                presentationAPI = configured
                let factory = api
                await store.observe(scope: scope, sessionID: sessionID, api: { try await factory().usingPresentationPolicy(configured) })
            } catch {
                guard !Task.isCancelled else { return }
                // Preserve access failures and unavailable capabilities; never
                // turn a rich rejection into a silent legacy subscription.
                store.presentationFailed(scope: scope, failure: error)
            }
        }
        .task(id: "\(scope):\(store.canonicalSessionID ?? ""):\(presentationAPI?.negotiation.capabilityDigest ?? ""):\(presentationAPI?.writesAvailable == true):\(presentationAPI?.paginationAvailable == true)") {
            actionRuntime.retire()
            guard let coordinatorFactory, let selected = presentationAPI, selected.writesAvailable || selected.paginationAvailable,
                  let canonical = store.canonicalSessionID else { return }
            do {
                let coordinator = try await coordinatorFactory(selected, canonical)
                guard !Task.isCancelled else { try? await coordinator.invalidate(clearRecoveryIdentity: false); return }
                actionRuntime.install(coordinator)
                await actionRuntime.recover(store: store, selected: selected, api: api)
            } catch { if !Task.isCancelled { actionRuntime.error = "Detail 操作暂不可用，未发送" } }
        }
        .confirmationDialog(actionRuntime.confirmation?.label.fallback ?? "确认操作", isPresented: Binding(
            get: { actionRuntime.confirmation != nil }, set: { if !$0 { actionRuntime.confirm(false) } }), titleVisibility: .visible) {
            Button("确认", role: actionRuntime.confirmation?.confirmation == "destructive" ? .destructive : nil) { actionRuntime.confirm(true) }
            Button("取消", role: .cancel) { actionRuntime.confirm(false) }
        }
        .onChange(of: presentsRichDocument, initial: true) { _, value in onPresentationChanged(value) }
        .onDisappear { actionRuntime.retire(); onPresentationChanged(nil) }
    }
}

/// Pure rendering entry point, also used by fixtures and previews without networking.
public struct ConversationDetailRenderer: View {
    private let store: ClientDetailStore
    private let refreshing: Bool
    private let perform: (ClientDetailAction) -> Void
    private let actions: ConversationDetailActions
    public init(store: ClientDetailStore, refreshing: Bool = false, perform: @escaping (ClientDetailAction) -> Void = { _ in }) {
        self.store = store; self.refreshing = refreshing; self.perform = perform
        self.actions = .init(canPerform: { $0.kind == "read" && $0.operation == "detail.refresh" && !refreshing }, perform: { action, _ in perform(action) })
    }
    public init(store: ClientDetailStore, refreshing: Bool = false, actions: ConversationDetailActions) {
        self.store = store; self.refreshing = refreshing; self.actions = actions
        self.perform = { action in actions.perform(action, [:]) }
    }
    public var body: some View {
        ForEach(store.orderedCards) { state in
            ConversationDetailRenderedCard(state: state, refreshing: refreshing, perform: perform, actions: actions, scope: store.renderingScope)
        }
    }
}

private struct ConversationDetailRenderedCard: View {
    let state: ClientDetailCardState
    let refreshing: Bool
    let perform: (ClientDetailAction) -> Void
    let actions: ConversationDetailActions
    let scope: String
    var body: some View {
        let scoped = actions.scoped(to: state.id)
        ConversationDetailModuleCard(title: state.card.displayTitle, systemImage: icon(state.card.semanticKind)) {
            ForEach(state.card.actions.filter { $0.kind == "read" && $0.operation == "detail.refresh" }) { action in
                Button { scoped.perform(action, [:]) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(!action.available || refreshing)
                    .accessibilityLabel(action.label.fallback)
            }
        } content: {
            ConversationDetailNodeView(state: state, nodeID: state.card.rootNodeId, actions: scoped, scope: scope)
        }
        .accessibilityIdentifier("detail-card-\(state.id)")
    }
    private func icon(_ kind: String) -> String {
        switch kind {
        case "information": "info.circle"
        case "summary": "text.alignleft"
        case "failure": "exclamationmark.octagon"
        case "warning": "exclamationmark.triangle"
        case "success": "checkmark.circle"
        case "scheduled": "clock"
        default: "square.text.square"
        }
    }
}

private struct ConversationDetailNodeView: View {
    @Bindable var state: ClientDetailCardState
    let nodeID: String
    let actions: ConversationDetailActions
    let scope: String
    var body: some View {
        if let node = state.nodes[nodeID] {
            if let component = state.card.v2Presentation?.components[nodeID] {
                ConversationDetailComponentView(state: state, node: node, component: component, actions: actions, scope: scope)
            } else { switch node.kind {
            case "column", "section":
                VStack(alignment: .leading, spacing: 6) { children(node) }
            case "row":
                HStack(alignment: .top, spacing: 8) { children(node) }
            case "text":
                Text(state.card.value(for: node)).font(.caption).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            case "markdown":
                ConversationDetailText(text: state.card.value(for: node))
            case "divider": Divider()
            case "disclosure":
                DisclosureGroup(isExpanded: Binding(get: { state.expandedNodes.contains(node.id) }, set: { expanded in
                    if expanded { state.expandedNodes.insert(node.id) } else { state.expandedNodes.remove(node.id) }
                })) { if state.expandedNodes.contains(node.id) { children(node) } }
                label: { Text(node.props.label?.fallback ?? state.card.fallback.fallback) }
            default:
                Label(state.card.fallback.fallback, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
            }
        }
    }
    // Type erasure is confined to the recursive extension boundary; validated depth <= 6.
    private func children(_ node: ClientDetailNode) -> some View {
        ForEach(node.children, id: \.self) { id in AnyView(ConversationDetailNodeView(state: state, nodeID: id, actions: actions, scope: scope)) }
    }
}
