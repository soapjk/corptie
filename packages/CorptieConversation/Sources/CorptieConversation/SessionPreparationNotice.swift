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
            Text(issue ?? preparation?.statusText ?? "正在核验会话，草稿已保留")
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Spacer(minLength: 4)
            if let preparation, preparation.isActive, issue == nil {
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
            let deadline = ContinuousClock.now.advanced(by: .seconds(120))
            while preparation?.isActive == true && ContinuousClock.now < deadline {
                try await Task.sleep(for: .seconds(2))
                let next = try await client.current(sessionID: sessionID)
                guard !Task.isCancelled else { return }
                if preparation != next { preparation = next }
            }
            guard !Task.isCancelled else { return }
            if preparation?.isReady == true { await didPrepare() }
            else if preparation?.isActive == true { issue = "核验仍在后台进行，可稍后重试；草稿已保留" }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            issue = "暂时无法核验会话，草稿已保留"
        }
    }
}
