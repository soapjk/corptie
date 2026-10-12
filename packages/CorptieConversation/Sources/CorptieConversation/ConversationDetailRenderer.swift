import SwiftUI
import CorptieClientCore

/// Incrementally migrated modules share this exact renderer on all three clients.
/// Existing resource/editor modules remain outside until their action contracts migrate.
public struct ConversationServerDetail: View {
    private let scope: String
    private let sessionID: String
    private let api: @Sendable () async throws -> ClientDetailAPI
    @State private var store = ClientDetailStore()
    @State private var refreshing = false

    public init(scope: String, sessionID: String, api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        self.scope = scope; self.sessionID = sessionID; self.api = api
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ConversationDetailRenderer(store: store, refreshing: refreshing) { action in
                    // Fail closed: this catalog currently registers only a read-only refresh.
                    guard action.kind == "read", action.operation == "detail.refresh", !refreshing else { return }
                    refreshing = true
                    Task {
                        defer { refreshing = false }
                        await store.refresh(sessionID: sessionID, api: api)
                    }
            }
            if let error = store.error { Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: scope) { await store.observe(scope: scope, sessionID: sessionID, api: api) }
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
        ConversationDetailModuleCard(title: state.card.displayTitle, systemImage: icon(state.card.semanticKind)) {
            ForEach(state.card.actions.filter { $0.kind == "read" && $0.operation == "detail.refresh" }) { action in
                Button { perform(action) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(!action.available || refreshing)
                    .accessibilityLabel(action.label.fallback)
            }
        } content: {
            ConversationDetailNodeView(state: state, nodeID: state.card.rootNodeId, actions: actions, scope: scope)
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
