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
    static let minimumUserMessages = 6
    private var knownUserIDs: [String] = []
    private var hasEnoughHistory = false
    var showsNavigation: Bool { hasEnoughHistory && !groups.isEmpty }
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
            knownUserIDs = []; hasEnoughHistory = false
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
                if candidate.olderCursor == nil && candidate.newerCursor == nil {
                    // A complete small directory is authoritative, including
                    // after deletion. Do not retain an obsolete visible state.
                    knownUserIDs = Array(candidate.items.prefix(Self.minimumUserMessages).map(\.id))
                } else {
                    for item in candidate.items where knownUserIDs.count < Self.minimumUserMessages {
                        if !knownUserIDs.contains(item.id) { knownUserIDs.append(item.id) }
                    }
                }
                hasEnoughHistory = knownUserIDs.count >= Self.minimumUserMessages
                let continuation = direction == "older" ? candidate.olderCursor : candidate.newerCursor
                guard candidate.items.isEmpty || !hasEnoughHistory else { break }
                guard let continuation, continuation != cursor else {
                    // Short histories must recheck the newest range next time,
                    // so a newly sent sixth message can reveal the rail.
                    if !hasEnoughHistory { cursor = nil; direction = "older" }
                    break
                }
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

/// One cancellable dwell task for the entire rail. Pointer exit is reconciled
/// on the next event turn (no dismissal timer), allowing source-to-panel transfer.
@MainActor @Observable
final class UserMessageNavigationHover {
    static let delay: Duration = .milliseconds(600)
    private(set) var preview: UserMessageNavigationGroup?
    private(set) var activated = false
    private(set) var pointerPosition: CGFloat?
    private var insideRail = false
    private var nearest: UserMessageNavigationGroup?
    private var insidePanel = false
    private var pending: Task<Void, Never>?
    private var exitCheck: Task<Void, Never>?
    private let wait: @Sendable (Duration) async throws -> Void

    init(wait: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.wait = wait
    }
    func enterRail() {
        exitCheck?.cancel()
        insideRail = true
        guard !activated, pending == nil else { return }
        let wait = wait
        pending = Task { [weak self] in
            do { try await wait(Self.delay) } catch { return }
            guard !Task.isCancelled, let self, self.insideRail else { return }
            self.pending = nil
            self.activated = true
            self.preview = self.nearest
        }
    }
    func enter(_ group: UserMessageNavigationGroup, position: CGFloat? = nil) {
        pointerPosition = position ?? CGFloat(group.ordinal)
        nearest = group
        enterRail()
        if activated, preview?.id != group.id { preview = group }
    }
    func leave(_ group: UserMessageNavigationGroup) {
        // Crossing rows or their boundaries stays within the same activated
        // region. Only the outer rail/panel boundary ends this interaction.
    }
    func leaveRail() {
        pointerPosition = nil
        activated = false
        insideRail = false
        pending?.cancel(); pending = nil
        reconcileExit()
    }
    func panelHover(_ inside: Bool) {
        insidePanel = inside
        if inside { exitCheck?.cancel() } else { reconcileExit() }
    }
    func showImmediately(_ group: UserMessageNavigationGroup) {
        pending?.cancel(); pending = nil
        exitCheck?.cancel()
        if insideRail { activated = true }
        nearest = group
        preview = group
    }
    func close() {
        pending?.cancel(); pending = nil
        exitCheck?.cancel(); exitCheck = nil
        insideRail = false; insidePanel = false; activated = false
        pointerPosition = nil; nearest = nil; preview = nil
    }
    private func reconcileExit() {
        exitCheck?.cancel()
        exitCheck = Task { [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, !self.insideRail, !self.insidePanel else { return }
            self.close()
        }
    }
}

enum UserMessageMarkerAppearance {
    static func width(index: Int, pointer: CGFloat?) -> CGFloat {
        guard let pointer else { return 10 }
        // Normalize to the closest bar, keeping it longest even between centers.
        // An exponential falloff has no equal-length stepped plateaus.
        let nearestDistance = abs(pointer - pointer.rounded())
        let distance = max(0, abs(CGFloat(index) - pointer) - nearestDistance)
        return 6 + 20 * CGFloat(exp(-Double(distance) * 0.42))
    }
}

/// Width interpolates in the painted path, not SwiftUI's layout negotiation.
struct UserMessageMarkerShape: Shape {
    var width: CGFloat
    var animatableData: CGFloat {
        get { width }
        set { width = newValue }
    }
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY, width: min(rect.width, max(0, width)), height: rect.height))
    }
}

/// Only the tiny glyph observes high-frequency pointer samples. Popover hosts
/// and reply text do not participate in every mouse-move rendering update.
private struct UserMessageNavigationMarkerGlyph: View {
    let index: Int
    let hover: UserMessageNavigationHover
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let pointer = hover.activated ? hover.pointerPosition : nil
        let emphasized = pointer.map { max(0, Int($0.rounded())) }
        let width = UserMessageMarkerAppearance.width(index: index, pointer: pointer)
        UserMessageMarkerShape(width: width)
            .fill(Color.primary.opacity(index == emphasized ? 0.9 : 0.18))
            .frame(width: 32, height: 2, alignment: .leading)
            // Phase edges ease in/out. Pointer motion itself must be direct,
            // otherwise a new 160ms tween continually chases the moving cursor.
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: pointer != nil)
            .animation(nil, value: pointer)
    }
}

struct UserMessageNavigationRail: View {
    let baseURL: URL
    let sessionID: String
    let active: Bool
    let navigate: (String) -> Void
    @State private var visibility = MacQuickMessageVisibility()
    @State private var state = UserMessageNavigationState()
    @State private var hover = UserMessageNavigationHover()

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(state.showsNavigation ? state.groups : []) { group in
                    Button {
                        if group.items.count == 1 { jump(group.items[0].id) }
                        else { hover.showImmediately(group) }
                    } label: {
                        UserMessageNavigationMarkerGlyph(index: group.ordinal, hover: hover)
                            .frame(width: 32, height: 10, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(group.items.first?.preview.isEmpty == false ? group.items[0].preview : "历史用户消息")
                    // macOS uses the source anchor edge; trailing presents right.
                    .popover(isPresented: Binding(get: { hover.preview?.id == group.id }, set: { shown in
                        if !shown && hover.preview?.id == group.id { hover.close() }
                    }), attachmentAnchor: .rect(.bounds), arrowEdge: .trailing) {
                        previewPanel
                    }
                }
            }
            .onContinuousHover { phase in
                if case .active(let point) = phase, state.showsNavigation, !state.groups.isEmpty {
                    // Content-local coordinates include scrolling. Continuous,
                    // contiguous rows select the nearest bar in constant time.
                    guard point.x >= 0, point.x <= 32, point.y >= 0,
                          point.y < CGFloat(state.groups.count) * 10 else {
                        hover.leaveRail(); return
                    }
                    let index = Int(point.y / 10)
                    hover.enter(state.groups[index], position: point.y / 10 - 0.5)
                } else if case .ended = phase {
                    hover.leaveRail()
                }
            }
        }
        .frame(width: 32).frame(maxHeight: min(360, CGFloat(state.groups.count) * 10))
        .opacity(state.showsNavigation ? 1 : 0)
        .allowsHitTesting(active && state.showsNavigation)
        .background { UserMessageNavigationVisibilityBridge { visibility = $0 } }
        .disabled(!active)
        .font(.system(size: 9, weight: .semibold))
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hover.enterRail() } else { hover.leaveRail() }
        }
        .task(id: "\(baseURL.absoluteString):\(sessionID):\(active):\(visibility.visible):\(visibility.activation)") {
            guard active, visibility.visible else { state.stop(); hover.close(); return }
            state.activate(baseURL: baseURL, sessionID: sessionID)
            while !Task.isCancelled {
                await state.refresh()
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
        .onChange(of: state.showsNavigation) { _, shown in if !shown { hover.close() } }
        .onChange(of: state.groups) { _, groups in
            if let id = hover.preview?.id {
                hover.showImmediately(groups.first { $0.id == id } ?? groups.last ?? .init(items: []))
            }
        }
        .onDisappear { hover.close(); state.stop() }
    }
    private var previewPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(hover.preview?.items ?? []) { item in
                Button { jump(item.id) } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(item.preview.isEmpty ? "附件或空消息" : item.preview)
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(.primary)
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
                    Button(state.error == nil ? "最近" : "重试") { move(nil, "older") }.disabled(state.loading)
                }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12).frame(width: 340)
        .onHover { hover.panelHover($0) }
        .onDisappear { hover.panelHover(false) }
    }
    private func move(_ cursor: String?, _ direction: String) {
        Task {
            await state.move(cursor: cursor, direction: direction)
            guard active, visibility.visible else { return }
            hover.showImmediately((direction == "older" ? state.groups.last : state.groups.first) ?? .init(items: []))
        }
    }
    private func jump(_ id: String) { hover.close(); navigate(id) }
}

/// Reuse the event-driven NSWindow probe also used by the composer. Independently
/// hosted AppKit pages cannot rely on a SwiftUI Scene's phase propagation.
private struct UserMessageNavigationVisibilityBridge: NSViewRepresentable {
    let changed: @MainActor (MacQuickMessageVisibility) -> Void
    func makeNSView(context: Context) -> MacQuickMessageVisibilityView { .init(changed: changed) }
    func updateNSView(_ view: MacQuickMessageVisibilityView, context: Context) { view.changed = changed }
    static func dismantleNSView(_ view: MacQuickMessageVisibilityView, coordinator: ()) { view.stop() }
}
