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
        guard selectedSessionID() == sessionID else { return }
        do {
            guard let usage = try await client.fetch(for: sessionID) else { return }
            guard selectedSessionID() == sessionID else { return }
            client.remember(usage, for: sessionID)
            state.selectedSessionUsage = usage
        } catch {
            // Usage is supplementary; failure must not disable conversation.
        }
    }

    func refreshFreshAccount(for sessionID: String) async -> SessionUsageResponse? {
        guard selectedSessionID() == sessionID else { return nil }
        do {
            guard let usage = try await client.fetchFreshAccount(for: sessionID),
                  !Task.isCancelled,
                  selectedSessionID() == sessionID else { return nil }
            client.remember(usage, for: sessionID)
            state.selectedSessionUsage = usage
            return usage
        } catch {
            return nil
        }
    }

    func refreshSelectedUsage() async {
        guard let sessionID = selectedSessionID() else { return }
        await loadUsage(for: sessionID)
    }
}
