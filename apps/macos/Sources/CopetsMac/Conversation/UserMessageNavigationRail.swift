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
    var id: String { items[0].id }
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
            let next = try await load(baseURL, sessionID, cursor, direction).validated()
            guard !Task.isCancelled, generation == request else { return }
            error = nil
            guard next.items != page?.items || next.olderCursor != page?.olderCursor
                || next.newerCursor != page?.newerCursor else { return }
            page = next
            // At most 32 markers; prepare groups when the bounded page changes,
            // never in hover callbacks or the view body.
            let chronological = Array(next.items.reversed())
            let groupSize = max(1, (chronological.count + 31) / 32)
            groups = stride(from: 0, to: chronological.count, by: groupSize).map {
                UserMessageNavigationGroup(items: Array(chronological[$0..<min($0 + groupSize, chronological.count)]))
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var state = UserMessageNavigationState()
    @State private var preview: UserMessageNavigationGroup?
    @State private var selectedID: String?
    @State private var pointerOnPreview = false
    @State private var pointerOnRail = false
    @State private var dismissal: Task<Void, Never>?

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
        VStack(spacing: 3) {
            Button { move(state.page?.olderCursor, "older") } label: {
                Image(systemName: "chevron.up").frame(width: 24, height: 24)
            }
            .disabled(state.loading || state.page?.olderCursor == nil)
            .help("更早的用户消息").accessibilityLabel("更早的用户消息")
            ForEach(state.groups) { group in
                Button {
                    if group.items.count == 1 { jump(group.items[0].id) }
                    else { preview = group }
                } label: {
                    Capsule().fill(Color.primary.opacity(preview?.id == group.id || group.items.contains(where: { $0.id == selectedID }) ? 0.8 : 0.32))
                        .frame(width: 12, height: 2)
                        .frame(width: 24, height: 7)
                        .contentShape(Rectangle())
                }
                .onHover { inside in
                    if inside { dismissal?.cancel(); preview = group }
                }
                .accessibilityLabel(group.items.first?.preview.isEmpty == false
                    ? group.items[0].preview : "历史用户消息")
                .help("预览并跳转到用户消息")
            }
            if state.loading && state.groups.isEmpty { ProgressView().controlSize(.mini).frame(width: 24, height: 18) }
            Button { move(state.page?.newerCursor, "newer") } label: {
                Image(systemName: "chevron.down").frame(width: 24, height: 24)
            }
            .disabled(state.loading || state.page?.newerCursor == nil)
            .help("更新的用户消息").accessibilityLabel("更新的用户消息")
            Button { move(nil, "older") } label: {
                Image(systemName: state.error == nil ? "clock.arrow.circlepath" : "arrow.clockwise")
                    .frame(width: 24, height: 24)
            }
            .disabled(state.loading)
            .help(state.error ?? "回到最近的用户消息目录")
            .accessibilityLabel(state.error == nil ? "最近的用户消息目录" : "重试读取用户消息目录")
        }
        }
        .frame(width: 24).frame(maxHeight: 360)
        .disabled(!active)
        .font(.system(size: 9, weight: .semibold))
        .buttonStyle(.plain)
        .padding(.vertical, 4)
        .onHover { inside in
            pointerOnRail = inside
            if inside { dismissal?.cancel() } else { scheduleDismissal() }
        }
        .popover(item: $preview, arrowEdge: .leading) { group in
            VStack(alignment: .leading, spacing: 6) {
                Text("历史用户消息").font(.caption).foregroundStyle(.secondary)
                ForEach(group.items) { item in
                    Button { jump(item.id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.preview.isEmpty ? "附件或空消息" : item.preview)
                                .lineLimit(4).frame(maxWidth: .infinity, alignment: .leading)
                            Text(item.createdAt).font(.caption2).foregroundStyle(.secondary)
                        }.padding(8).contentShape(Rectangle())
                    }.buttonStyle(.plain).consoleHoverFeedback()
                }
            }
            .font(.system(size: 12))
            .padding(10).frame(width: 300)
            .onHover { inside in
                pointerOnPreview = inside
                if inside { dismissal?.cancel() } else { scheduleDismissal() }
            }
        }
        .task(id: "\(baseURL.absoluteString):\(sessionID):\(active):\(scenePhase)") {
            guard active, scenePhase == .active else { state.stop(); preview = nil; return }
            state.activate(baseURL: baseURL, sessionID: sessionID)
            // Current-page polling handles edits/deletions/backfills without
            // observing model streaming updates or doing work on hover.
            while !Task.isCancelled {
                await state.refresh()
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
        .onChange(of: state.groups) { _, groups in
            if let id = preview?.id { preview = groups.first { $0.id == id } }
        }
        .onDisappear { dismissal?.cancel(); state.stop() }
    }
    private func move(_ cursor: String?, _ direction: String) {
        preview = nil
        Task { await state.move(cursor: cursor, direction: direction) }
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
