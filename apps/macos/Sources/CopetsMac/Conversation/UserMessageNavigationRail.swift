import Foundation
import SwiftUI
import Observation
import CorptieClientCore

/// Network and decoding stay off the main actor. No cache files or full-history bodies.
actor UserMessageNavigationReader {
    static let shared = UserMessageNavigationReader()
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()
    func page(baseURL: URL, sessionID: String, cursor: String?, direction: String) async throws -> ClientUserMessageNavigationPage {
        var url = URLComponents(url: baseURL.appending(path: "sessions/\(sessionID)/user-message-navigation"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "direction", value: direction)]
            + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
        var request = URLRequest(url: url.url!)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (bytes, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, bytes.count <= 200_000 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ClientUserMessageNavigationPage.self, from: bytes).validated()
    }
}

struct UserMessageNavigationGroup: Identifiable, Equatable {
    let items: [ClientUserMessageNavigationPage.Item]
    let ordinal: Int
    init(items: [ClientUserMessageNavigationPage.Item], ordinal: Int = 0) {
        self.items = items; self.ordinal = ordinal
    }
    var id: String { items.first?.id ?? "empty-navigation-page" }
}

@MainActor @Observable
final class UserMessageNavigationState {
    private(set) var groups: [UserMessageNavigationGroup] = []
    private(set) var page: ClientUserMessageNavigationPage?
    private(set) var loading = false
    private(set) var error: String?
    private var generation = 0
    private var isActive = false
    private var cursor: String?
    private var direction = "older"
    private var baseURL: URL?
    private var sessionID = ""
    typealias Loader = @Sendable (URL, String, String?, String) async throws -> ClientUserMessageNavigationPage
    private let load: Loader
    init(load: @escaping Loader = { try await UserMessageNavigationReader.shared.page(baseURL: $0, sessionID: $1, cursor: $2, direction: $3) }) { self.load = load }

    func activate(baseURL: URL, sessionID: String) {
        if self.baseURL != baseURL || self.sessionID != sessionID {
            groups = []; page = nil; cursor = nil; direction = "older"
        }
        self.baseURL = baseURL; self.sessionID = sessionID
        stop()
        isActive = true
    }
    func stop() { isActive = false; generation &+= 1; loading = false }
    func move(cursor: String?, direction: String) async {
        guard isActive else { return }
        self.cursor = cursor; self.direction = direction
        generation &+= 1; loading = false
        await refresh()
    }
    func refresh() async {
        guard isActive, !loading, let baseURL else { return }
        generation &+= 1
        let request = generation
        loading = true
        defer { if generation == request { loading = false } }
        do {
            var next: ClientUserMessageNavigationPage?
            // Skip sparse ranges in bounded background batches. No placeholder
            // markers and no need to click through model/tool-only pages.
            for _ in 0..<8 {
                let candidate = try await load(baseURL, sessionID, cursor, direction).validated()
                guard !Task.isCancelled, generation == request else { return }
                next = candidate
                let continuation = direction == "older" ? candidate.olderCursor : candidate.newerCursor
                guard candidate.items.isEmpty, let continuation, continuation != cursor else { break }
                cursor = continuation
            }
            guard let next else { return }
            error = nil
            guard next.items != page?.items || next.olderCursor != page?.olderCursor
                || next.newerCursor != page?.newerCursor else { return }
            page = next
            // At most 32 markers; prepare groups when the bounded page changes,
            // never in hover callbacks or the view body.
            let chronological = Array(next.items.reversed())
            let groupSize = max(1, (chronological.count + 31) / 32)
            groups = stride(from: 0, to: chronological.count, by: groupSize).map {
                UserMessageNavigationGroup(items: Array(chronological[$0..<min($0 + groupSize, chronological.count)]), ordinal: $0 / groupSize)
            }
        } catch {
            guard !Task.isCancelled, generation == request else { return }
            self.error = "暂时无法读取历史消息"
        }
    }
}

struct UserMessageNavigationRail: View {
    let baseURL: URL
    let sessionID: String
    let active: Bool
    let navigate: (String) -> Void
    @State private var visibility = MacQuickMessageVisibility()
    @State private var state = UserMessageNavigationState()
    @State private var preview: UserMessageNavigationGroup?
    @State private var selectedID: String?
    @State private var pointerOnPreview = false
    @State private var pointerOnRail = false
    @State private var dismissal: Task<Void, Never>?

    var body: some View {
        let emphasizedIndex = preview?.ordinal
            ?? state.groups.first(where: { $0.items.contains(where: { $0.id == selectedID }) })?.ordinal
            ?? max(0, state.groups.count - 1)
        ScrollView(.vertical, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(state.groups) { group in
                Button {
                    if group.items.count == 1 { jump(group.items[0].id) }
                    else { preview = group }
                } label: {
                    Rectangle().fill(Color.primary.opacity(group.ordinal == emphasizedIndex ? 0.9 : 0.18))
                        .frame(width: markerWidth(distance: abs(group.ordinal - emphasizedIndex)), height: 2)
                        .frame(width: 32, height: 8, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .onHover { inside in
                    if inside { dismissal?.cancel(); preview = group }
                }
                .accessibilityLabel(group.items.first?.preview.isEmpty == false
                    ? group.items[0].preview : "历史用户消息")
                .popover(isPresented: Binding(get: { preview?.id == group.id }, set: { shown in
                    if !shown && preview?.id == group.id { preview = nil }
                }), attachmentAnchor: .rect(.bounds), arrowEdge: .leading) {
                    previewPanel
                }
            }
        }
        }
        .frame(width: 32).frame(maxHeight: 360)
        .opacity(state.groups.isEmpty ? 0 : 1)
        .allowsHitTesting(active && !state.groups.isEmpty)
        .background { UserMessageNavigationVisibilityBridge { visibility = $0 } }
        .disabled(!active)
        .font(.system(size: 9, weight: .semibold))
        .buttonStyle(.plain)
        .padding(.vertical, 4)
        .onHover { inside in
            pointerOnRail = inside
            if inside { dismissal?.cancel() } else { scheduleDismissal() }
        }
        .task(id: "\(baseURL.absoluteString):\(sessionID):\(active):\(visibility.visible):\(visibility.activation)") {
            guard active, visibility.visible else { state.stop(); preview = nil; return }
            state.activate(baseURL: baseURL, sessionID: sessionID)
            // Current-page polling handles edits/deletions/backfills without
            // observing model streaming updates or doing work on hover.
            while !Task.isCancelled {
                await state.refresh()
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
        .onChange(of: state.groups) { _, groups in
            if let id = preview?.id { preview = groups.first { $0.id == id } ?? groups.last ?? .init(items: []) }
        }
        .onDisappear { dismissal?.cancel(); state.stop() }
    }
    private func markerWidth(distance: Int) -> CGFloat {
        switch distance {
        case 0: 26
        case 1, 2: 20
        case 3: 14
        default: 10
        }
    }

    private var previewPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(preview?.items ?? []) { item in
                Button { jump(item.id) } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(item.preview.isEmpty ? "附件或空消息" : item.preview)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                        if let reply = item.replyPreview, !reply.isEmpty {
                            Text(reply).font(.system(size: 13)).foregroundStyle(.secondary)
                                .lineLimit(4).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Text(String(item.createdAt.prefix(16)).replacingOccurrences(of: "T", with: " "))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }.padding(6).contentShape(Rectangle())
                }.buttonStyle(.plain).consoleHoverFeedback()
            }
            if state.loading { ProgressView().controlSize(.small) }
            if let error = state.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            if state.page?.olderCursor != nil || state.page?.newerCursor != nil || state.error != nil {
                Divider()
                HStack(spacing: 12) {
                    Button("更早") { move(state.page?.olderCursor, "older") }
                        .disabled(state.loading || state.page?.olderCursor == nil)
                    Button("更新") { move(state.page?.newerCursor, "newer") }
                        .disabled(state.loading || state.page?.newerCursor == nil)
                    Spacer()
                    Button(state.error == nil ? "最近" : "重试") { move(nil, "older") }
                        .disabled(state.loading)
                }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12).frame(width: 340)
        .onHover { inside in
            pointerOnPreview = inside
            if inside { dismissal?.cancel() } else { scheduleDismissal() }
        }
        .onDisappear { pointerOnPreview = false }
    }

    private func move(_ cursor: String?, _ direction: String) {
        Task {
            await state.move(cursor: cursor, direction: direction)
            guard active, visibility.visible else { return }
            preview = (direction == "older" ? state.groups.last : state.groups.first) ?? .init(items: [])
        }
    }
    private func jump(_ id: String) { selectedID = id; preview = nil; navigate(id) }
    private func scheduleDismissal() {
        dismissal?.cancel()
        dismissal = Task {
            do { try await Task.sleep(for: .milliseconds(180)) } catch { return }
            guard !pointerOnRail, !pointerOnPreview else { return }
            preview = nil
        }
    }
}

/// Reuse the event-driven NSWindow probe also used by the composer. Independently
/// hosted AppKit pages cannot rely on a SwiftUI Scene's phase propagation.
private struct UserMessageNavigationVisibilityBridge: NSViewRepresentable {
    let changed: @MainActor (MacQuickMessageVisibility) -> Void
    func makeNSView(context: Context) -> MacQuickMessageVisibilityView { .init(changed: changed) }
    func updateNSView(_ view: MacQuickMessageVisibilityView, context: Context) { view.changed = changed }
    static func dismantleNSView(_ view: MacQuickMessageVisibilityView, coordinator: ()) { view.stop() }
}
