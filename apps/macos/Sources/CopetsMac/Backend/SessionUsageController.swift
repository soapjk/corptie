import Foundation

/// Owns the fallback poll and the debounced account refresh as one lifecycle.
/// The selected value stays in the existing supplementary state controller.
@MainActor
final class SessionUsageController {
    private let client: any SessionUsageServing
    private let state: SessionSupplementaryDataController
    private let selectedSessionID: () -> String?
    private var refreshTask: Task<Void, Never>?
    private var eventRefreshTask: Task<Void, Never>?
    private var fetchGeneration: UInt64 = 0

    init(
        client: any SessionUsageServing,
        state: SessionSupplementaryDataController,
        selectedSessionID: @escaping () -> String?
    ) {
        self.client = client
        self.state = state
        self.selectedSessionID = selectedSessionID
    }

    func publishCachedUsage(for sessionID: String) {
        state.selectedSessionUsage = client.cached(for: sessionID)
    }

    func stopRefreshing() {
        refreshTask?.cancel()
        refreshTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
    }

    func startRefreshing(for sessionID: String) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadUsage(for: sessionID)
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { return }
            }
        }
    }

    func applyLiveEvent(_ data: String) {
        guard let sessionID = selectedSessionID(),
              let usage = client.applyingEvent(data, sessionID: sessionID, current: state.selectedSessionUsage)
        else { return }
        state.selectedSessionUsage = usage
        eventRefreshTask?.cancel()
        eventRefreshTask = Task { [weak self] in
            do {
                // One authoritative account read after a burst of token updates.
                try await Task.sleep(for: .seconds(1))
            } catch {
                return
            }
            guard let self, self.selectedSessionID() == sessionID else { return }
            await self.refreshSelectedUsage()
        }
    }

    func loadUsage(for sessionID: String) async {
        _ = await fetchUsage(for: sessionID)
    }

    private func fetchUsage(for sessionID: String) async -> Bool {
        guard selectedSessionID() == sessionID else { return false }
        fetchGeneration &+= 1
        let generation = fetchGeneration
        do {
            guard let usage = try await client.fetch(for: sessionID) else { return false }
            guard selectedSessionID() == sessionID, generation == fetchGeneration else { return false }
            client.remember(usage, for: sessionID)
            state.selectedSessionUsage = usage
            return true
        } catch {
            // Usage is supplementary; failure must not disable conversation.
            return false
        }
    }

    func refreshSelectedUsage() async {
        guard let sessionID = selectedSessionID() else { return }
        await loadUsage(for: sessionID)
    }

    func refreshSelectedUsageWithOutcome() async -> Bool {
        guard let sessionID = selectedSessionID() else { return false }
        return await fetchUsage(for: sessionID)
    }
}
