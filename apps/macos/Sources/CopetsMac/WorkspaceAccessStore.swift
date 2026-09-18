import Foundation

/// Persists only directories that the user explicitly selected in a system
/// open panel. Keeping the root access alive avoids asking again for each child
/// folder while a Work is active.
@MainActor
final class WorkspaceAccessStore {
    static let shared = WorkspaceAccessStore(defaults: CorptieAppEnvironment.userDefaults)

    private struct Record: Codable, Equatable {
        let path: String
        let bookmark: Data
        let isSecurityScoped: Bool
    }

    private let defaults: UserDefaults
    private let storageKey: String
    private var activeURLs: [String: URL] = [:]

    init(defaults: UserDefaults, storageKey: String = "corptie.workspaceAccess.bookmarks.v1") {
        self.defaults = defaults
        self.storageKey = storageKey
    }

    /// Records access granted by NSOpenPanel. A parent authorization replaces
    /// redundant child records, so the app never grows a bookmark per Worktree.
    @discardableResult
    func authorize(_ selectedURL: URL) -> Bool {
        let url = selectedURL.standardizedFileURL
        let path = url.path
        if authorizedPaths.contains(where: { Self.contains(path, within: $0) }) {
            return true
        }

        let bookmark: Data
        let isSecurityScoped: Bool
        do {
            bookmark = try url.bookmarkData(
                options: .withSecurityScope,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            isSecurityScoped = true
        } catch {
            // Corptie is currently non-sandboxed. A regular bookmark still
            // preserves the explicit root selection; stable code signing lets
            // macOS retain the corresponding privacy grant across upgrades.
            guard let fallback = try? url.bookmarkData(
                options: .minimalBookmark,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            ) else { return false }
            bookmark = fallback
            isSecurityScoped = false
        }

        var records = loadRecords().filter { !Self.contains($0.path, within: path) }
        records.append(Record(path: path, bookmark: bookmark, isSecurityScoped: isSecurityScoped))
        persist(records)
        activate(url, securityScoped: isSecurityScoped)
        return true
    }

    /// Resolving bookmarks is intentionally the only launch-time operation. It
    /// does not enumerate roots or probe descendants, and silently drops stale
    /// entries instead of causing a cascade of permission dialogs.
    func restore() {
        var valid: [Record] = []
        for record in loadRecords() {
            var stale = false
            let options: URL.BookmarkResolutionOptions = record.isSecurityScoped ? .withSecurityScope : []
            guard let url = try? URL(
                resolvingBookmarkData: record.bookmark,
                options: options,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            ), !stale else { continue }
            let standardized = url.standardizedFileURL
            valid.append(Record(
                path: standardized.path,
                bookmark: record.bookmark,
                isSecurityScoped: record.isSecurityScoped
            ))
            activate(standardized, securityScoped: record.isSecurityScoped)
        }
        if valid != loadRecords() { persist(valid) }
    }

    var authorizedPaths: [String] {
        loadRecords().map(\.path)
    }

    func covers(_ url: URL) -> Bool {
        let path = url.standardizedFileURL.path
        return authorizedPaths.contains(where: { Self.contains(path, within: $0) })
    }

    private func activate(_ url: URL, securityScoped: Bool) {
        guard activeURLs[url.path] == nil else { return }
        if securityScoped { _ = url.startAccessingSecurityScopedResource() }
        activeURLs[url.path] = url
    }

    private func loadRecords() -> [Record] {
        guard let data = defaults.data(forKey: storageKey),
              let records = try? JSONDecoder().decode([Record].self, from: data) else { return [] }
        return records
    }

    private func persist(_ records: [Record]) {
        guard let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private static func contains(_ candidate: String, within root: String) -> Bool {
        let rootComponents = URL(fileURLWithPath: root).standardizedFileURL.pathComponents
        let candidateComponents = URL(fileURLWithPath: candidate).standardizedFileURL.pathComponents
        return candidateComponents.count >= rootComponents.count
            && Array(candidateComponents.prefix(rootComponents.count)) == rootComponents
    }
}
