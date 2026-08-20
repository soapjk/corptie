import Foundation

enum BackendResponseDecoder {
    static func sessions(from data: Data) async throws -> [TaskSession] {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
        }.value
    }

    static func detail(
        from data: Data,
        threadId: String,
        authoritativeCwd: String?,
        workspacePath: String? = nil
    ) async throws -> CodexThreadDetail {
        try await Task.detached(priority: .userInitiated) {
            let snapshot = try JSONDecoder().decode(UnifiedSessionSnapshotResponse.self, from: data).session
            return CodexThreadDetail(
                id: threadId,
                title: snapshot.title,
                status: snapshot.status,
                source: snapshot.source,
                connectionStatus: snapshot.connectionStatus,
                currentModel: snapshot.currentModel,
                currentReasoningLevel: snapshot.currentReasoningLevel,
                activityStatus: snapshot.activityStatus,
                cwd: preferredWorkspacePath(
                    authoritativePath: authoritativeCwd,
                    providerPath: snapshot.cwd,
                    workspacePath: workspacePath
                ),
                createdAt: snapshot.createdAt,
                updatedAt: snapshot.updatedAt,
                canSend: snapshot.canSend,
                sendUnavailableReason: snapshot.sendUnavailableReason,
                capabilities: snapshot.capabilities,
                turnCount: snapshot.turnCount,
                items: snapshot.items,
                lastAgentMessageSequence: snapshot.lastAgentMessageSequence,
                hasMoreHistory: snapshot.hasMoreHistory,
                historyItemsCount: snapshot.historyItemsCount,
                actions: snapshot.actions
            )
        }.value
    }

    static func preferredWorkspacePath(
        authoritativePath: String?,
        providerPath: String?,
        workspacePath: String? = nil
    ) -> String? {
        let workspace = workspacePath?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let workspace, !workspace.isEmpty {
            return workspace
        }
        let saved = authoritativePath?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let saved, !saved.isEmpty {
            return saved
        }
        let provider = providerPath?.trimmingCharacters(in: .whitespacesAndNewlines)
        return provider?.isEmpty == false ? provider : nil
    }

    static func streamedDetail(from data: Data) async throws -> CodexThreadDetail {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(CodexThreadDetailResponse.self, from: data).thread
        }.value
    }
}
