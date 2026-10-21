import Foundation

/// Context-reference operations share the existing supplementary panel state.
/// Selection remains external; a late list response cannot replace another Session's list.
@MainActor
final class SessionContextReferenceController {
    private let api: any SessionContextReferenceServing
    private let state: SessionSupplementaryDataController
    private let selectedSession: () -> TaskSession?
    private let reportError: (String?) -> Void
    private var loadGeneration = UUID()

    init(
        api: any SessionContextReferenceServing,
        state: SessionSupplementaryDataController,
        selectedSession: @escaping () -> TaskSession?,
        reportError: @escaping (String?) -> Void
    ) {
        self.api = api
        self.state = state
        self.selectedSession = selectedSession
        self.reportError = reportError
    }

    func loadContextReferences(for session: TaskSession? = nil) async {
        if let session, selectedSession()?.id != session.id { return }
        let generation = UUID(); loadGeneration = generation
        guard let target = session ?? selectedSession(),
              [.assistantChat, .workChat, .worker].contains(target.resolvedSessionKind) else {
            state.selectedContextReferences = []
            state.isLoadingContextReferences = false
            return
        }
        guard selectedSession()?.id == target.id else { return }
        state.isLoadingContextReferences = true
        defer { if loadGeneration == generation { state.isLoadingContextReferences = false } }
        do {
            let references = try await api.list(sessionID: target.id)
            if !Task.isCancelled, loadGeneration == generation, selectedSession()?.id == target.id {
                state.selectedContextReferences = references
                reportError(nil)
            }
        } catch {
            if !Task.isCancelled, loadGeneration == generation, selectedSession()?.id == target.id { reportError(error.localizedDescription) }
        }
    }

    @discardableResult
    func addContextReference(
        to session: TaskSession,
        type: SessionContextReferenceType,
        targetId: String? = nil,
        locator: String? = nil,
        displayName: String? = nil
    ) async -> Bool {
        guard isCurrentOwner(session), !Task.isCancelled else { return false }
        do {
            try await api.add(sessionID: session.id, type: type, targetID: targetId, locator: locator, displayName: displayName)
            await loadContextReferences(for: session)
            return true
        } catch {
            if isCurrentOwner(session) { reportError(error.localizedDescription) }
            return false
        }
    }

    func setContextReferenceEnabled(_ reference: SessionContextReference, enabled: Bool) async {
        await updateContextReference(reference, body: ["enabled": enabled])
    }

    func replaceContextReferenceFile(_ reference: SessionContextReference, path: String) async {
        await updateContextReference(reference, body: ["locator": path])
    }

    func refreshContextReference(_ reference: SessionContextReference) async {
        guard let session = selectedSession(), owns(reference, session: session) else { return }
        do {
            try await api.refresh(sessionID: session.id, referenceID: reference.referenceId)
            await loadContextReferences(for: session)
        } catch {
            if isCurrentOwner(session) { reportError(error.localizedDescription) }
        }
    }

    func deleteContextReference(_ reference: SessionContextReference) async {
        guard let session = selectedSession(), owns(reference, session: session) else { return }
        do {
            try await api.delete(sessionID: session.id, referenceID: reference.referenceId)
            await loadContextReferences(for: session)
        } catch {
            if isCurrentOwner(session) { reportError(error.localizedDescription) }
        }
    }

    private func updateContextReference(_ reference: SessionContextReference, body: [String: Any]) async {
        guard let session = selectedSession(), owns(reference, session: session) else { return }
        do {
            try await api.update(sessionID: session.id, referenceID: reference.referenceId, body: body)
            await loadContextReferences(for: session)
        } catch {
            if isCurrentOwner(session) { reportError(error.localizedDescription) }
        }
    }

    private func isCurrentOwner(_ session: TaskSession) -> Bool {
        guard let current = selectedSession(), current.archived != true else { return false }
        return current.id == session.id && current.taskId == session.taskId && current.workId == session.workId
    }
    private func owns(_ reference: SessionContextReference, session: TaskSession) -> Bool {
        isCurrentOwner(session) && (reference.ownerSessionId == session.id || reference.ownerSessionId == session.external?.logicalSessionId)
    }
}
