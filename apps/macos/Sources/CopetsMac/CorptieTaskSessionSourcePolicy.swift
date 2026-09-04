import Foundation

/// Chooses the Session actor used to authorize Task creation and companion
/// Session recovery. The actor must belong to the same Work; global UI
/// selection is only a preference and may never leak across Work boundaries.
enum CorptieTaskSessionSourcePolicy {
    static func resolve(
        workId: String,
        preferred: TaskSession?,
        sessions: [TaskSession]
    ) -> TaskSession? {
        let candidates = sessions.filter {
            $0.workId == workId
                && $0.archived != true
                && sourceSessionId(for: $0) != nil
        }
        if let preferred,
           candidates.contains(where: { $0.id == preferred.id }) {
            return preferred
        }
        return candidates.first(where: { $0.resolvedSessionKind == .workChat })
            ?? candidates.first(where: { $0.resolvedSessionKind == .worker })
            ?? candidates.first
    }

    static func sourceSessionId(for session: TaskSession) -> String? {
        if let logical = normalized(session.external?.logicalSessionId),
           logical.hasPrefix("logical:") {
            return logical
        }
        let id = normalized(session.id)
        guard id?.hasPrefix("session:") == true || id?.hasPrefix("logical:") == true else {
            return nil
        }
        return id
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}
