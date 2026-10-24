import Foundation
import Observation

/// A composer owns at most one image import transaction. Disappearing invalidates
/// it even when an underlying file/provider operation cannot be cancelled.
@MainActor @Observable
final class ComposerImageImportState {
    private(set) var busy = false
    private(set) var errorMessage: String?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var active = true
    @ObservationIgnored var task: Task<Void, Never>?

    func begin() -> UUID? {
        guard active, !busy else { return nil }
        generation = UUID()
        errorMessage = nil
        busy = true
        return generation
    }

    func accepts(_ token: UUID) -> Bool { active && busy && generation == token }

    func showError(_ message: String, token: UUID? = nil) {
        guard active, token.map({ accepts($0) }) ?? true else { return }
        errorMessage = message
    }

    func dismissError() { errorMessage = nil }

    func finish(_ token: UUID) {
        guard generation == token else { return }
        busy = false
        task = nil
    }

    func activate() { active = true }

    func invalidate() {
        active = false
        errorMessage = nil
        generation = UUID()
        busy = false
        task?.cancel()
        task = nil
    }
}
