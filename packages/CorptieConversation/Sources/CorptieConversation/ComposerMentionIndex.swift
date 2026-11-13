import Foundation

extension ComposerMentionCatalog {
    /// Immutable search data. Search returns identities, not eagerly formatted
    /// row presentations; the lazy menu resolves only the rows it displays.
    public struct Index: Sendable {
        public struct Match: Identifiable, Sendable, Equatable {
            public let id: String
            public let position: Int
        }

        private struct Entry: Sendable {
            let id: String
            let targetID: String
            let name: String
            let kind: ComposerMentionSuggestion.Kind
            let workName: String?
            let workLabel: String

            var detail: String {
                switch kind {
                case .work: workLabel
                case .session: workName.map { "Session · Work: \($0)" } ?? "Session"
                case .skill: "Skill"
                case .mcp: "MCP"
                }
            }
        }

        private let entries: [Entry]

        public init(works: [Work], sessions: [Session], workLabel: String = "Work", abilities: [Ability] = []) throws {
            let groups = Dictionary(grouping: sessions, by: { $0.workId ?? "" })
            let workIDs = Set(works.map(\.id))
            var entries: [Entry] = []
            entries.reserveCapacity(works.count + sessions.count)
            func append(_ session: Session, workName: String?) {
                entries.append(Entry(id: "session:" + session.id, targetID: session.id,
                    name: session.title, kind: .session, workName: workName, workLabel: workLabel))
            }
            for work in works {
                try Task.checkCancellation()
                entries.append(Entry(id: "work:" + work.id, targetID: work.id,
                    name: work.name, kind: .work, workName: nil, workLabel: workLabel))
                for session in groups[work.id] ?? [] { append(session, workName: work.name) }
            }
            for (offset, session) in sessions.enumerated() {
                if offset.isMultiple(of: 128) { try Task.checkCancellation() }
                if !workIDs.contains(session.workId ?? "") { append(session, workName: nil) }
            }
            for ability in abilities where ability.kind == .skill || ability.kind == .mcp {
                try Task.checkCancellation()
                entries.append(Entry(id: ability.kind.rawValue + ":" + ability.id, targetID: ability.id,
                    name: ability.name, kind: ability.kind, workName: nil, workLabel: workLabel))
            }
            self.entries = entries
        }

        public func matches(query: String, currentSessionID: String,
                            activeMentionIDs: Set<String>) throws -> [Match] {
            guard activeMentionIDs.count < ComposerShellMetrics.maximumMentions else { return [] }
            let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
            var result: [Match] = []
            for (position, entry) in entries.enumerated() {
                if position.isMultiple(of: 128) { try Task.checkCancellation() }
                guard !(entry.kind == .session && entry.targetID == currentSessionID),
                      !activeMentionIDs.contains(entry.id) else { continue }
                if needle.isEmpty || entry.name.localizedCaseInsensitiveContains(needle)
                    || entry.targetID.localizedCaseInsensitiveContains(needle)
                    || entry.detail.localizedCaseInsensitiveContains(needle) {
                    result.append(Match(id: entry.id, position: position))
                }
            }
            return result
        }

        public func suggestion(for match: Match) -> ComposerMentionSuggestion? {
            guard entries.indices.contains(match.position), entries[match.position].id == match.id else { return nil }
            let entry = entries[match.position]
            return ComposerMentionSuggestion(kind: entry.kind, targetId: entry.targetID,
                displayName: entry.name, detail: entry.detail)
        }
    }
}
