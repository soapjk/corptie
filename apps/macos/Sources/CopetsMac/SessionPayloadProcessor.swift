import Foundation

actor SessionPayloadProcessor {
    private var revision: UInt64 = 0

    func processSnapshot(
        data: Data,
        current: [TaskSession]
    ) throws -> (sessions: [TaskSession], patch: SessionCollectionPatch) {
        let sessions = try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
        revision &+= 1
        return (
            sessions,
            SessionCollectionDiffer.patch(from: current, to: sessions, revision: revision)
        )
    }

    func processSnapshot(
        sessions: [TaskSession],
        current: [TaskSession]
    ) -> SessionCollectionPatch {
        revision &+= 1
        return SessionCollectionDiffer.patch(from: current, to: sessions, revision: revision)
    }
}
