import SwiftUI
import ImageIO
import CorptieClientCore

/// Platform operations are explicit, capability-gated callbacks. The component
/// layer neither chooses endpoints nor implements command receipts/retries.
@MainActor public struct ConversationDetailActions {
    public let canPerform: (ClientDetailAction) -> Bool
    public let perform: (ClientDetailAction, [String: ClientInspectorValue]) -> Void
    public let resolveImage: (@Sendable (ClientDetailAction.Target) async throws -> Data)?
    private let performInCard: ((String, ClientDetailAction, [String: ClientInspectorValue]) -> Void)?
    private let canPerformInCard: ((String, ClientDetailAction) -> Bool)?
    public init(canPerform: @escaping (ClientDetailAction) -> Bool,
                perform: @escaping (ClientDetailAction, [String: ClientInspectorValue]) -> Void,
                resolveImage: (@Sendable (ClientDetailAction.Target) async throws -> Data)? = nil,
                performInCard: ((String, ClientDetailAction, [String: ClientInspectorValue]) -> Void)? = nil,
                canPerformInCard: ((String, ClientDetailAction) -> Bool)? = nil) {
        self.canPerform = canPerform; self.perform = perform; self.resolveImage = resolveImage
        self.performInCard = performInCard; self.canPerformInCard = canPerformInCard
    }
    func scoped(to cardID: String) -> Self {
        .init(canPerform: { action in canPerform(action) && (canPerformInCard?(cardID, action) ?? true) }, perform: { action, fields in
            if let performInCard { performInCard(cardID, action, fields) } else { perform(action, fields) }
        }, resolveImage: resolveImage)
    }
}

/// Dirty fields survive business updates. A changed resource revision requires
/// an explicit reload; this value type cannot retry or report write success.
struct ConversationDetailFormDraft: Equatable {
    private(set) var values: [String: ClientInspectorValue] = [:]
    private(set) var dirty = false
    private(set) var conflict = false
    private(set) var resourceRevision: String?
    mutating func receive(values: [String: ClientInspectorValue], resourceRevision: String?) {
        if dirty {
            conflict = conflict || self.resourceRevision != resourceRevision
        } else {
            self.values = values; self.resourceRevision = resourceRevision; conflict = false
        }
    }
    mutating func edit(_ field: String, value: ClientInspectorValue) { values[field] = value; dirty = true }
    mutating func reload(values: [String: ClientInspectorValue], resourceRevision: String?) {
        dirty = false; conflict = false; receive(values: values, resourceRevision: resourceRevision)
    }
}

struct ConversationDetailComponentView: View {
    let state: ClientDetailCardState
    let node: ClientDetailNode
    let component: ClientDetailComponent
    let actions: ConversationDetailActions
    let scope: String
    var body: some View {
        switch node.kind {
        case "detail.keyValue":
            HStack(alignment: .top, spacing: 8) {
                if let label = component.label { Text(label.fallback).foregroundStyle(.secondary) }
                Text(value.text ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .trailing)
            }.font(.caption)
        case "detail.status":
            if let text = value.text, !text.isEmpty {
                Label(text, systemImage: symbol(component.semantic ?? "neutral"))
                    .font(.caption).foregroundStyle(color(component.semantic ?? "neutral"))
            }
        case "detail.progress":
            ProgressView(value: value.number ?? 0, total: 100) {
                if let label = component.label { Text(label.fallback).font(.caption) }
            }
        case "detail.dateTime":
            if let date = state.card.v2Presentation?.dates[node.id] {
                switch component.format ?? "dateTime" {
                case "date": Text(date, format: .dateTime.year().month().day()).font(.caption)
                case "time": Text(date, format: .dateTime.hour().minute()).font(.caption)
                default: Text(date, format: .dateTime.year().month().day().hour().minute()).font(.caption)
                }
            }
        case "detail.resourceList": resourceList
        case "detail.image":
            ConversationDetailResourceImage(resource: value, label: component.label?.fallback ?? "", resolver: actions.resolveImage)
        case "detail.markdown", "detail.chart":
            ConversationDetailPreparedContent(source: value.text ?? "", identity: state.id + ":" + node.id,
                format: node.kind == "detail.chart" ? .chart : .markdown, scope: scope)
        case "detail.form":
            ConversationDetailForm(state: state, component: component, actions: actions)
        case "detail.button": actionButton(component.actionId)
        default: EmptyView()
        }
    }
    private var value: ClientInspectorValue { node.binding.flatMap { state.card.data[$0] } ?? .null }
    private func symbol(_ semantic: String) -> String {
        switch semantic {
        case "failure": "exclamationmark.octagon"
        case "warning": "exclamationmark.triangle"
        case "success": "checkmark.circle"
        case "retrying": "arrow.clockwise"
        case "scheduled": "clock"
        default: "info.circle"
        }
    }
    private func color(_ semantic: String) -> Color {
        switch semantic { case "failure": .red; case "warning": .orange; case "success": .green; default: .secondary }
    }
    @ViewBuilder private func actionButton(_ id: String?, fields: [String: ClientInspectorValue] = [:], navigationSource: [String: ClientInspectorValue]? = nil) -> some View {
        if let id, let action = state.card.actions.first(where: { $0.id == id }) {
            let button = Button(action.label.fallback, role: component.presentationRole == "destructive" ? .destructive : nil) {
                // Local native navigation context only; never augment command
                // or read RPC fields with collection metadata.
                var context = fields
                if action.kind == "navigation", let navigationSource {
                    context = ["sourceResourceType": navigationSource["resourceType"] ?? .null,
                               "sourceResourceId": navigationSource["id"] ?? .null]
                }
                actions.perform(action, context)
            }
                .disabled(!action.available || !actions.canPerform(action))
                .help(action.reason?.fallback ?? "")
            switch component.presentationRole {
            case "primary", "link": button.buttonStyle(.plain).foregroundStyle(Color.accentColor)
            case "secondary": button.buttonStyle(.plain)
            case "destructive": button
            default: button // Frozen profile1 preserves platform defaults.
            }
        }
    }
    @ViewBuilder private var resourceList: some View {
        if let name = component.collection, let page = state.card.v2Presentation?.collections[name] {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(page.order, id: \.self) { id in
                    if let item = page.items[id] {
                        if component.presentation == "disclosure" {
                            resourceDisclosure(name: name, id: id, item: item)
                        } else {
                            HStack(alignment: .top, spacing: 8) {
                                Label(item["title"]?.text ?? "", systemImage: "doc")
                                    .font(.caption).fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                                actionButton(item["actionId"]?.text, navigationSource: item)
                            }
                        }
                    }
                }
                if let cursor = page.nextCursor {
                    // Cursor already binds the server-side revision/scope.
                    // Match the closed Action operation fields exactly.
                    actionButton(component.actionId, fields: ["collectionName": .string(name), "cursor": .string(cursor)])
                }
            }
        }
    }
    private func resourceDisclosure(name: String, id: String, item: [String: ClientInspectorValue]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            DisclosureGroup(isExpanded: Binding(get: { state.isResourceExpanded(collection: name, id: id) },
                set: { state.setResourceExpanded(collection: name, id: id, $0) })) {
                if state.isResourceExpanded(collection: name, id: id) {
                    if let field = component.itemBindings?["body"], let body = item[field]?.text, !body.isEmpty {
                        ConversationDetailPreparedContent(source: body, identity: state.id + ":" + node.id + ":" + id,
                            format: .markdown, scope: scope)
                    }
                    if let field = component.itemBindings?["metadata"], let metadata = item[field]?.text, !metadata.isEmpty {
                        Text(metadata).font(.caption).foregroundStyle(.secondary)
                    }
                    actionButton(item["actionId"]?.text, navigationSource: item)
                }
            } label: { Text(item["title"]?.text ?? "").font(.caption) }
            if !state.isResourceExpanded(collection: name, id: id), let field = component.itemBindings?["preview"],
               let preview = item[field]?.text, !preview.isEmpty {
                Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(5)
            }
        }
    }
}

enum ConversationDetailFormInputPolicy {
    static func isMultiline(operation: String?, field: String) -> Bool {
        operation == "memory.update" && field == "content"
    }
    static func acceptsReferenceLocator(_ value: String) -> Bool {
        guard value.utf16.count <= 4096, let url = URL(string: value),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return false }
        return true
    }
}

private struct ConversationDetailForm: View {
    let state: ClientDetailCardState
    let component: ClientDetailComponent
    let actions: ConversationDetailActions
    @State private var draft = ConversationDetailFormDraft()
    private var action: ClientDetailAction? { state.card.actions.first { $0.id == component.actionId } }
    private var source: [String: ClientInspectorValue] {
        Dictionary(uniqueKeysWithValues: (component.controls ?? []).compactMap { control in
            state.card.data[control.field].map { (control.field, $0) }
        })
    }
    private var valid: Bool {
        if action?.operation == "memory.update" {
            let content = draft.values["content"]?.text ?? ""
            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.utf16.count > 16000 { return false }
        }
        if action?.operation == "reference.add", !ConversationDetailFormInputPolicy.acceptsReferenceLocator(draft.values["locator"]?.text ?? "") { return false }
        return (component.controls ?? []).allSatisfy { control in
            switch control.kind {
            case "text": (draft.values[control.field]?.text?.unicodeScalars.count ?? 0) <= (state.card.v2Presentation?.fieldLimits[control.field] ?? 4096)
            case "toggle": if case .bool = draft.values[control.field] { true } else { false }
            case "picker": control.options?.contains { $0.value == draft.values[control.field]?.text } ?? false
            default: false
            }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(component.controls ?? [], id: \.field) { control in
                switch control.kind {
                case "text":
                    if ConversationDetailFormInputPolicy.isMultiline(operation: action?.operation, field: control.field) {
                        TextField(control.label.fallback, text: binding(control.field), axis: .vertical)
                            .lineLimit(3...8)
                    } else {
                        TextField(control.label.fallback, text: binding(control.field))
                            .autocorrectionDisabled(action?.operation == "reference.add" && control.field == "locator")
                    }
                case "toggle":
                    Toggle(control.label.fallback, isOn: Binding(get: { draft.values[control.field] == .bool(true) },
                        set: { draft.edit(control.field, value: .bool($0)) }))
                case "picker":
                    Picker(control.label.fallback, selection: Binding(get: { draft.values[control.field]?.text ?? "" },
                        set: { draft.edit(control.field, value: .string($0)) })) {
                        ForEach(control.options ?? [], id: \.value) { Text($0.label.fallback).tag($0.value) }
                    }
                default: EmptyView()
                }
            }
            if draft.conflict {
                Label("Resource changed. Reload before submitting.", systemImage: "exclamationmark.triangle").font(.caption)
                Button("Reload") { draft.reload(values: source, resourceRevision: action?.expectedResourceRevision) }
            }
            if let action {
                Button(action.label.fallback) { actions.perform(action, draft.values) }
                    .disabled(draft.conflict || !valid || !action.available || !actions.canPerform(action))
            }
        }
        .onAppear { draft.receive(values: source, resourceRevision: action?.expectedResourceRevision) }
        .onChange(of: source) { _, values in draft.receive(values: values, resourceRevision: action?.expectedResourceRevision) }
        .onChange(of: action?.expectedResourceRevision) { _, revision in draft.receive(values: source, resourceRevision: revision) }
    }
    private func binding(_ field: String) -> Binding<String> {
        Binding(get: { draft.values[field]?.text ?? "" }, set: { draft.edit(field, value: .string($0)) })
    }
}

private struct DetailContentWidth: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ConversationDetailPreparedContent: View {
    let source: String
    let identity: String
    let format: ConversationDetailRichContent.Format
    let scope: String
    @Environment(\.locale) private var locale
    @State private var width: CGFloat = 0
    @State private var rendered: ConversationDetailRichContentView?
    @State private var renderedScope: String?
    @State private var cache = ConversationDetailRichContentCache(maximumEntries: 1, maximumBytes: 512 * 1024)
    private struct Input: Hashable { let source: String; let width: CGFloat; let scope: String; let locale: String; let format: ConversationDetailRichContent.Format }
    var body: some View {
        Group { if let rendered, renderedScope == scope { rendered } else { Color.clear.frame(height: 1) } }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GeometryReader { proxy in Color.clear.preference(key: DetailContentWidth.self, value: floor(proxy.size.width)) })
            .onPreferenceChange(DetailContentWidth.self) { if width != $0 { width = $0 } }
            .onChange(of: scope) { old, _ in
                rendered = nil
                Task { await cache.removeScope(old) }
            }
            .onDisappear { rendered = nil; Task { await cache.removeAll() } }
            .task(id: Input(source: source, width: width, scope: scope, locale: locale.identifier, format: format)) {
                guard width > 0 else { return }
                let text = format == .chart ? "```corptie-chart\n" + source + "\n```" : source
                guard let content = try? await cache.content(key: .init(scope: scope, cardID: identity, nodeID: "content"), source: text, format: format,
                    parameters: .init(rendererVersion: 1, localeID: locale.identifier)) else { return }
                guard !Task.isCancelled else { return }
                rendered = ConversationDetailRichContentView(content: content, width: width)
                renderedScope = scope
            }
    }
}

private struct ConversationDetailResourceImage: View {
    let resource: ClientInspectorValue
    let label: String
    let resolver: (@Sendable (ClientDetailAction.Target) async throws -> Data)?
    @State private var image: CGImage?
    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 1).resizable().scaledToFit().frame(maxHeight: 180).accessibilityLabel(label)
            } else { Label(label, systemImage: "photo").font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: resource) {
            image = nil
            guard let resolver, let target = try? JSONDecoder().decode(ClientDetailAction.Target.self, from: JSONEncoder().encode(resource)) else { return }
            do {
                let bytes = try await resolver(target)
                guard bytes.count <= 2 * 1024 * 1024, !Task.isCancelled else { return }
                let thumbnail = await Task.detached(priority: .utility) {
                    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                          CGImageSourceGetCount(source) == 1,
                          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                          let width = properties[kCGImagePropertyPixelWidth] as? Int,
                          let height = properties[kCGImagePropertyPixelHeight] as? Int,
                          width > 0, height > 0, width <= 8192, height <= 8192,
                          width * height <= 32 * 1024 * 1024 else { return Optional<CGImage>.none }
                    return CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceThumbnailMaxPixelSize: 512, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary)
                }.value
                guard !Task.isCancelled else { return }
                image = thumbnail
            } catch { image = nil }
        }
    }
}
