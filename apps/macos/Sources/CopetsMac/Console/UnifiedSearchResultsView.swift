import SwiftUI
import CorptieClientCore

struct UnifiedSearchRequest: Equatable, Hashable {
    let query: String
    let scope: String
    let workID: String?
}

@MainActor
final class UnifiedSearchModel: ObservableObject {
    @Published private(set) var items: [UnifiedSearchHit] = []
    @Published private(set) var cursor: String?
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published private(set) var reachedLimit = false
    @Published private(set) var indexState = "ready"
    private var generation = 0
    private var request: UnifiedSearchRequest?
    private let fetch: (UnifiedSearchRequest, String?) async throws -> UnifiedSearchPage

    init(fetch: @escaping (UnifiedSearchRequest, String?) async throws -> UnifiedSearchPage = UnifiedSearchModel.fetchPage) {
        self.fetch = fetch
    }

    func search(_ request: UnifiedSearchRequest) async {
        generation &+= 1
        let expected = generation
        self.request = request
        items = []; cursor = nil; error = nil; isLoading = true; reachedLimit = false
        do {
            try await Task.sleep(for: .milliseconds(300))
            let page = try await fetch(request, nil)
            guard !Task.isCancelled, generation == expected else { return }
            guard page.schemaVersion == 1, page.query == request.query else { throw SearchFailure.invalidResponse }
            items = page.items; cursor = page.nextCursor; indexState = page.indexState
        } catch {
            if !Task.isCancelled, generation == expected { self.error = L10n("Search unavailable. Try again.") }
        }
        if generation == expected { isLoading = false }
    }

    func loadMore() async {
        guard let request, let cursor, !isLoading else { return }
        let expected = generation
        isLoading = true; error = nil
        defer { if expected == generation { isLoading = false } }
        do {
            let page = try await fetch(request, cursor)
            guard !Task.isCancelled, expected == generation else { return }
            guard page.schemaVersion == 1, page.query == request.query else { throw SearchFailure.invalidResponse }
            let seen = Set(items.map(\.id))
            items += page.items.filter { !seen.contains($0.id) }
            reachedLimit = items.count >= 300 && page.nextCursor != nil
            items = Array(items.prefix(300))
            self.cursor = reachedLimit ? nil : page.nextCursor; indexState = page.indexState
        } catch {
            if expected == generation { self.error = L10n("Search unavailable. Try again.") }
        }
    }

    private enum SearchFailure: Error { case invalidResponse }
    static func fetchPage(_ request: UnifiedSearchRequest, _ cursor: String?) async throws -> UnifiedSearchPage {
        var url = URLComponents(url: CorptieAppEnvironment.backendBaseURL.appending(path: "search"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "q", value: request.query), URLQueryItem(name: "scope", value: request.scope)]
        if let workID = request.workID { url.queryItems?.append(URLQueryItem(name: "workId", value: workID)) }
        if let cursor { url.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        let (data, response) = try await URLSession.shared.data(from: url.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SearchFailure.invalidResponse }
        return try await Task.detached { try JSONDecoder().decode(UnifiedSearchPage.self, from: data) }.value
    }
}

struct UnifiedSearchResultsView: View {
    let query: String
    let currentWorkID: String?
    let submitRevision: Int
    let open: (UnifiedSearchHit) async throws -> Void
    @ObservedObject private var searchNavigation = UnifiedSearchNavigation.shared
    @StateObject private var model = UnifiedSearchModel()
    @State private var scope = "all"
    @State private var currentWorkOnly = false
    @State private var selectedID: String?
    @State private var retryRevision = 0
    @State private var navigationError: String?
    @State private var opening = false
    @State private var navigationTask: Task<Void, Never>?
    @State private var collapsedGroups = Set<String>()

    private var request: UnifiedSearchRequest {
        UnifiedSearchRequest(query: query.trimmingCharacters(in: .whitespacesAndNewlines), scope: scope,
                             workID: currentWorkOnly ? currentWorkID : nil)
    }
    private var titles: [UnifiedSearchHit] { model.items.filter { $0.kind != "message" } }
    private var groups: [(id: String, hits: [UnifiedSearchHit])] {
        var order: [String] = [], values: [String: [UnifiedSearchHit]] = [:]
        for hit in model.items where hit.kind == "message" {
            let id = hit.sessionId ?? hit.id
            if values[id] == nil { order.append(id) }
            values[id, default: []].append(hit)
        }
        return order.map { ($0, values[$0] ?? []) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(L10n("Search scope"), selection: $scope) {
                Text(L10n("All")).tag("all")
                Text(L10n("Titles")).tag("titles")
                Text(L10n("Chat history")).tag("messages")
            }.pickerStyle(.segmented)
            if currentWorkID != nil {
                Toggle(L10n("Current Work only"), isOn: $currentWorkOnly).toggleStyle(.checkbox)
            }
            if model.indexState == "building" {
                Text(L10n("Historical messages are being indexed. Results may be incomplete."))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n("Refresh results")) { retryRevision &+= 1 }
            }
            if let error = searchNavigation.error { Text(error).font(.caption).foregroundStyle(.red) }
            if let navigationError { Text(navigationError).font(.caption).foregroundStyle(.red) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(titles) { hit in result(hit) }
                    ForEach(groups, id: \.id) { group in
                        DisclosureGroup(isExpanded: Binding(
                            get: { !collapsedGroups.contains(group.id) },
                            set: { if $0 { collapsedGroups.remove(group.id) } else { collapsedGroups.insert(group.id) } }
                        )) {
                            ForEach(group.hits) { hit in result(hit) }
                        } label: {
                            Text(group.hits.first?.title ?? L10n("Chat"))
                                .font(.subheadline.weight(.semibold)).lineLimit(1)
                        }
                    }
                    if model.items.isEmpty, !model.isLoading, model.error == nil {
                        Text(L10n("No search results")).foregroundStyle(.secondary).padding(.vertical, 12)
                    }
                    if model.reachedLimit {
                        Text(L10n("Showing the first 300 results. Refine your search to find more."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if model.isLoading { ProgressView().controlSize(.small) }
                    if let error = model.error {
                        Text(error).font(.caption).foregroundStyle(.red)
                        Button(L10n("Retry")) { retryRevision &+= 1 }
                    }
                    if model.cursor != nil, !model.isLoading {
                        Button(L10n("Load more")) { Task { await model.loadMore() } }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .task(id: request) {
            navigationTask?.cancel(); navigationTask = nil
            opening = false; selectedID = nil; navigationError = nil
            await model.search(request)
        }
        .onDisappear { navigationTask?.cancel() }
        .task(id: retryRevision) { if retryRevision > 0 { await model.search(request) } }
        .onChange(of: model.items) { _, items in
            if let sessionID = searchNavigation.target?.sessionID { searchNavigation.setMatches(items, sessionID: sessionID) }
        }
        .onChange(of: submitRevision) { _, _ in
            if let hit = model.items.first(where: { $0.id == selectedID }) ?? model.items.first { navigate(hit) }
        }
        .onKeyPress(.downArrow) { moveSelection(1); return .handled }
        .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
    }

    private func moveSelection(_ delta: Int) {
        guard !model.items.isEmpty else { return }
        let index = selectedID.flatMap { id in model.items.firstIndex(where: { $0.id == id }) } ?? -1
        selectedID = model.items[min(model.items.count - 1, max(0, index + delta))].id
    }
    private func result(_ hit: UnifiedSearchHit) -> some View {
        Button { selectedID = hit.id; navigate(hit) } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.kind == "message" ? L10n("Chat history") : hit.kind.capitalized).font(.caption).foregroundStyle(.secondary)
                    Text(highlight(hit.title)).font(.subheadline.weight(.medium)).lineLimit(1)
                    if hit.archived { Text(L10n("Archived")).font(.caption).foregroundStyle(.secondary) }
                }
                if !hit.snippet.isEmpty { Text(highlight(hit.snippet)).font(.caption).lineLimit(4) }
                Text([hit.workTitle, hit.taskTitle, hit.createdAt].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            .background(selectedID == hit.id ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(opening)
    }
    private func highlight(_ text: String) -> AttributedString {
        var result = AttributedString(text)
        var range = text.startIndex..<text.endIndex
        while let found = text.range(of: request.query, options: [.caseInsensitive], range: range), !request.query.isEmpty {
            if let start = AttributedString.Index(found.lowerBound, within: result), let end = AttributedString.Index(found.upperBound, within: result) {
                result[start..<end].inlinePresentationIntent = .stronglyEmphasized
            }
            range = found.upperBound..<text.endIndex
        }
        return result
    }
    private func navigate(_ hit: UnifiedSearchHit) {
        guard !opening else { return }
        if let sessionID = hit.sessionId, hit.messageId != nil {
            searchNavigation.setMatches(model.items, sessionID: sessionID)
        }
        opening = true; navigationError = nil
        navigationTask = Task {
            defer { if !Task.isCancelled { opening = false } }
            do { try await open(hit) }
            catch { if !Task.isCancelled { navigationError = error.localizedDescription } }
        }
    }
}
