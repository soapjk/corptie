import Foundation

/// Context-reference operations share the existing supplementary panel state.
/// Selection remains external; a late list response cannot replace another Session's list.
@MainActor
final class SessionContextReferenceController {
    private let api: any SessionContextReferenceServing
    private let state: SessionSupplementaryDataController
    private let selectedSession: () -> TaskSession?
    private let reportError: (String?) -> Void

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
        guard let target = session ?? selectedSession(),
              target.resolvedSessionKind == .assistantChat || target.resolvedSessionKind == .workChat else {
            state.selectedContextReferences = []
            return
        }
        state.isLoadingContextReferences = true
        defer { state.isLoadingContextReferences = false }
        do {
            let references = try await api.list(sessionID: target.id)
            if selectedSession()?.id == target.id {
                state.selectedContextReferences = references
            }
            reportError(nil)
        } catch {
            reportError(error.localizedDescription)
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
        do {
            try await api.add(sessionID: session.id, type: type, targetID: targetId, locator: locator, displayName: displayName)
            await loadContextReferences(for: session)
            return true
        } catch {
            reportError(error.localizedDescription)
            return false
        }
    }

    func setContextReferenceEnabled(_ reference: SessionContextReference, enabled: Bool) async {
        await updateContextReference(reference, body: ["enabled": enabled])
    }

    func refreshContextReference(_ reference: SessionContextReference) async {
        guard let session = selectedSession() else { return }
        do {
            try await api.refresh(sessionID: session.id, referenceID: reference.referenceId)
            await loadContextReferences(for: session)
        } catch {
            reportError(error.localizedDescription)
        }
    }

    func deleteContextReference(_ reference: SessionContextReference) async {
        guard let session = selectedSession() else { return }
        do {
            try await api.delete(sessionID: session.id, referenceID: reference.referenceId)
            await loadContextReferences(for: session)
        } catch {
            reportError(error.localizedDescription)
        }
    }

    private func updateContextReference(_ reference: SessionContextReference, body: [String: Any]) async {
        guard let session = selectedSession() else { return }
        do {
            try await api.update(sessionID: session.id, referenceID: reference.referenceId, body: body)
            await loadContextReferences(for: session)
        } catch {
            reportError(error.localizedDescription)
        }
    }
}
