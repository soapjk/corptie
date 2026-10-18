import SwiftUI
import CorptieClientCore

/// Local recovery chrome only. It never owns the composer draft or Timeline.
@MainActor
public struct SessionPreparationNotice: View {
    private let sessionID: String
    private let api: @MainActor () async throws -> ClientSessionPreparationAPI
    private let didPrepare: @MainActor () async -> Void
    @State private var preparation: ClientSessionPreparation?
    @State private var issue: String?
    @State private var revision = 0
    @State private var cancelAttemptID: String?

    public init(sessionID: String,
                api: @escaping @MainActor () async throws -> ClientSessionPreparationAPI,
                didPrepare: @escaping @MainActor () async -> Void) {
        self.sessionID = sessionID; self.api = api; self.didPrepare = didPrepare
    }

    public var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(issue ?? preparation?.statusText ?? "正在核验会话，草稿已保留")
                if let detail = preparation?.failureDetail, issue == nil {
                    Text(detail)
                }
            }
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            Spacer(minLength: 4)
            if let preparation, preparation.isAwaitingConfirmation, issue == nil {
                Button("停止等待") { cancelAttemptID = preparation.id; revision += 1 }
                    .accessibilityHint("只停止核验等待，不声称远端操作已取消")
            } else if preparation?.isReady != true {
                Button("重新核验") { cancelAttemptID = nil; revision += 1 }
                    .accessibilityHint("结果未知时只核对状态，不重发消息")
            }
        }
        .buttonStyle(.bordered).controlSize(.small)
        .accessibilityIdentifier("session-preparation-notice")
        .task(id: "\(sessionID):\(revision)") { await run() }
    }

    private func run() async {
        issue = nil
        do {
            let client = try await api()
            let initial = if let cancelAttemptID {
                try await client.cancel(sessionID: sessionID, attemptID: cancelAttemptID)
            } else {
                try await client.start(sessionID: sessionID)
            }
            guard !Task.isCancelled else { return }
            preparation = initial
            while preparation?.isAwaitingConfirmation == true {
                let awaitingRemoteResult = preparation?.isActive != true
                try await Task.sleep(for: .seconds(awaitingRemoteResult ? 10 : 2))
                // For an unknown sent operation, start only schedules the
                // server's read-only reconciliation of the same attempt.
                let next = if awaitingRemoteResult {
                    try await client.start(sessionID: sessionID)
                } else {
                    try await client.current(sessionID: sessionID)
                }
                guard !Task.isCancelled else { return }
                if preparation != next { preparation = next }
            }
            guard !Task.isCancelled else { return }
            if preparation?.isReady == true { await didPrepare() }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            issue = "\(ClientSessionPreparation.requestFailureDetail(error))；草稿已保留"
        }
    }
}
