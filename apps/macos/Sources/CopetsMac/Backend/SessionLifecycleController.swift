import Foundation

private struct ProviderSwitchErrorEnvelope: Decodable {
    let error: String
    let code: String?
    let expectedRoutingVersion: Int?
    let currentRoutingVersion: Int?
    let session: TaskSession?
}

struct SessionRestartActivity: Equatable {
    let text: String
    let isActive: Bool
}

/// Connection transitions, restart presentation, and Provider switching share one lifecycle.
@MainActor
final class SessionLifecycleController {
    private let baseURL: URL
    private let commands: SessionCommandController
    private let restartActivity: SessionRestartActivityController
    private let acceptRoute: (TaskSession) -> Void
    private let errorMessage: (Data) -> String?
    private let currentError: () -> String?
    private let reportError: (String?) -> Void
    private var restartActivityClearTasks: [String: Task<Void, Never>] = [:]

    private var connectionTransitionSessionIds: Set<String> {
        get { commands.connectionTransitionSessionIds }
        set { commands.connectionTransitionSessionIds = newValue }
    }
    private var restartingSessionIds: Set<String> {
        get { commands.restartingSessionIds }
        set { commands.restartingSessionIds = newValue }
    }
    private var restartActivityBySessionId: [String: SessionRestartActivity] {
        get { restartActivity.activityBySessionID }
        set { restartActivity.activityBySessionID = newValue }
    }
    private var sendStatusMessage: String? {
        get { commands.sendStatusMessage }
        set { commands.sendStatusMessage = newValue }
    }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, commands: SessionCommandController,
         restartActivity: SessionRestartActivityController,
         acceptRoute: @escaping (TaskSession) -> Void,
         errorMessage: @escaping (Data) -> String?,
         currentError: @escaping () -> String?,
         reportError: @escaping (String?) -> Void) {
        self.baseURL = baseURL
        self.commands = commands
        self.restartActivity = restartActivity
        self.acceptRoute = acceptRoute
        self.errorMessage = errorMessage
        self.currentError = currentError
        self.reportError = reportError
    }

    func interrupt(session: TaskSession, surface: SessionInterruptSurface) {
        let source = SessionInterruptSource.userAction(surface: surface)
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/interrupt"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONEncoder().encode(SessionInterruptRequest(source: source))
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(errorMessage(data) ?? "Interrupt failed")
                }
                sendStatusMessage = L10n("Interrupted")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Interrupt failed: %@", error.localizedDescription)
            }
        }
    }

    func togglePtyConnection(for session: TaskSession) {
        guard session.usesManualConnection else {
            return
        }

        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                let action = session.isConnected ? "disconnect" : "reconnect"
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/\(action)"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                sendStatusMessage = session.isConnected ? L10n("PTY disconnected") : L10n("PTY reconnected")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = session.isConnected
                    ? "Disconnect failed: \(error.localizedDescription)"
                    : "Reconnect failed: \(error.localizedDescription)"
            }
        }
    }

    func reconnect(session: TaskSession) {
        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = L10n("Reconnecting...")
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/resume"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                sendStatusMessage = L10n("Reconnected")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Reconnect failed: %@", error.localizedDescription)
            }
        }
    }

    func restart(session: TaskSession) {
        guard session.actions?.restart?.available == true,
              !restartingSessionIds.contains(session.id) else {
            return
        }

        Task {
            restartingSessionIds.insert(session.id)
            beginRestartActivity(for: session.id)
            defer {
                restartingSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = L10n("Restarting session…")
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/restart"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "idempotencyKey": "session-restart:\(UUID().uuidString.lowercased())"
                ])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        errorMessage(data) ?? L10n("Could not restart session.")
                    )
                }
                sendStatusMessage = httpResponse.statusCode == 202
                    ? L10n("Session will restart after the current run finishes")
                    : L10n("Session restarted")
                if httpResponse.statusCode == 202 {
                    deferRestartActivity(for: session.id)
                } else {
                    completeRestartActivity(for: session.id)
                }
            } catch {
                failRestartActivity(for: session.id)
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Restart failed: %@", error.localizedDescription)
            }
        }
    }

    @discardableResult
    func switchProvider(session: TaskSession, to providerId: String) async -> Bool {
        await switchProvider(session: session, to: providerId, retryOnStaleRoute: true)
    }

    private func switchProvider(
        session: TaskSession,
        to providerId: String,
        retryOnStaleRoute: Bool
    ) async -> Bool {
        let target = providerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, target != session.external?.provider else { return false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/switch-provider"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = [
                "providerId": target,
                "transitionId": "provider-transition:\(UUID().uuidString.lowercased())"
            ]
            if let routingVersion = session.external?.routingVersion {
                body["expectedRoutingVersion"] = routingVersion
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            guard (200..<300).contains(http.statusCode) else {
                let failure = try? JSONDecoder().decode(ProviderSwitchErrorEnvelope.self, from: data)
                if failure?.code == "STALE_SESSION_ROUTE", let current = failure?.session {
                    acceptRoute(current)
                    if retryOnStaleRoute {
                        return await switchProvider(
                            session: current,
                            to: target,
                            retryOnStaleRoute: false
                        )
                    }
                }
                throw BackendError.message(failure?.error ?? errorMessage(data) ?? L10n("Provider 切换失败"))
            }
            sendStatusMessage = http.statusCode == 202
                ? L10n("当前回复完成后切换 Provider")
                : L10n("Provider 已切换")
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    private func beginRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Restarting session…"),
            isActive: true
        )
    }

    func completeRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Session restarted"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(2))
    }

    private func deferRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Session will restart after the current run finishes"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(4))
    }

    func failRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Restart failed"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(4))
    }

    private func scheduleRestartActivityClear(for sessionId: String, after delay: Duration) {
        restartActivityClearTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.restartActivityBySessionId.removeValue(forKey: sessionId)
            self?.restartActivityClearTasks.removeValue(forKey: sessionId)
        }
    }
}
