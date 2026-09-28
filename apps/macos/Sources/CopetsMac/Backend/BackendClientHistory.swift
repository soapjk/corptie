import Foundation

extension BackendClient {
    func workspaceHistory(for session: TaskSession) async -> [SessionWorkspaceHistory] {
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/workspaces")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load workspace history.")
            }
            return try JSONDecoder().decode(SessionWorkspaceHistoryResponse.self, from: data).history
        } catch {
            lastError = error.localizedDescription
            return []
        }
    }

    func openHistoricalThread(_ history: SessionWorkspaceHistory, for session: TaskSession) async -> Bool {
        guard history.readOnly else {
            select(session: session)
            return true
        }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/bindings/\(history.bindingId)/snapshot")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load historical thread.")
            }
            let detail = try await BackendResponseDecoder.detail(
                from: data,
                threadId: history.providerThreadId,
                authoritativeCwd: history.boundCwd,
                workspacePath: history.boundCwd
            )
            sessionSelectionController.select(session.id)
            supplementaryDataController.select(session.id)
            viewingHistoricalThreadId = history.providerThreadId
            selectedHistoricalDetail = detail
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func returnToActiveThread() {
        guard let selectedSession else { return }
        select(session: selectedSession)
    }

    func fetchDetail(for session: TaskSession, reportsErrors: Bool = true) async -> CodexThreadDetail? {
        let snapshot: (detail: CodexThreadDetail, timelineRevision: Int)
        switch await fetchStoredDetail(for: session) {
        case .success(let loaded):
            snapshot = loaded
        case .failure(let error):
            if reportsErrors { lastError = error.localizedDescription }
            return nil
        }
        let detail = applyingHandledChoices(to: detailByMergingPendingMessages(snapshot.detail))
        storeCachedDetail(
            detail,
            for: session.id,
            timelineRevision: snapshot.timelineRevision
        )
        if reportsErrors, lastError != nil { lastError = nil }
        return detail
    }

    /// Persist a read receipt only through the exact agent-message cursor from
    /// the Session snapshot the user opened. A newer message arriving
    /// concurrently therefore remains unread until the open Session snapshot
    /// advances and acknowledges that newer cursor too.
    func markSessionMessagesRead(sessionID: String, throughSequence: Int) async -> Bool {
        guard throughSequence >= 0 else { return false }
        do {
            let url = baseURL.appending(path: "sessions/\(sessionID)/read-receipt")
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "throughSequence": throughSequence
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not update the Session read receipt.")
            }
            let receipt = try JSONDecoder().decode(SessionReadReceiptResponse.self, from: data)
            appState.acceptReadReceipt(receipt, requestedSessionID: sessionID)
            return true
        } catch {
            return false
        }
    }
}
