import SwiftUI
import CorptieClientCore

/// Read-only, self-driving Session readiness chrome.
///
/// It never owns the composer draft, never offers a control, and never asks the
/// user to confirm recovery: a confirmed attempt refreshes the authoritative
/// snapshot, which removes the owning surface. While the Session stays
/// unavailable it shows one reason only, then retries on its own.
@MainActor
public struct SessionPreparationNotice: View {
    private let activity: ConversationDetailPresentationActivity?
    private var isActive: Bool { activity?.isActive ?? true }
    private let sessionID: String
    private let fallbackReason: String
    private let api: @MainActor () async throws -> ClientSessionPreparationAPI
    private let didPrepare: @MainActor () async -> Void
    @State private var preparation: ClientSessionPreparation?
    @State private var issue: String?

    public init(sessionID: String,
                api: @escaping @MainActor () async throws -> ClientSessionPreparationAPI,
                didPrepare: @escaping @MainActor () async -> Void,
                activity: ConversationDetailPresentationActivity? = nil,
                fallbackReason: String = "会话不可用") {
        self.sessionID = sessionID; self.api = api; self.didPrepare = didPrepare
        self.activity = activity; self.fallbackReason = fallbackReason
    }

    public var body: some View {
        // The task lives on a stable container so it keeps running even after a
        // confirmed attempt stops rendering chrome.
        VStack(spacing: 0) {
            if preparation?.isReady != true {
                Text(displayedReason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("session-preparation-notice")
            }
        }
        .task(id: "\(sessionID):\(isActive):\(activity?.generation ?? 0)") { await run() }
    }

    /// Only reasons, never progress or success copy: a ready Session shows
    /// nothing here at all.
    private var displayedReason: String {
        if let issue { return issue }
        if let detail = preparation?.failureDetail { return detail }
        return fallbackReason
    }

    private func run() async {
        guard isActive else { return }
        let generation = activity?.generation ?? 0
        let accepts = { !Task.isCancelled && (activity?.allows(generation: generation) ?? true) }
        let backoff: [Duration] = [.seconds(2), .seconds(5), .seconds(10)]
        var retryIndex = 0

        while !Task.isCancelled && accepts() {
            do {
                let client = try await api()
                guard accepts() else { return }
                var current = try await client.start(sessionID: sessionID)
                guard accepts() else { return }
                preparation = current
                issue = nil
                retryIndex = 0

                while current?.isAwaitingConfirmation == true && !Task.isCancelled && accepts() {
                    let awaitingRemoteResult = current?.isActive != true
                    try await Task.sleep(for: awaitingRemoteResult ? .seconds(10) : .seconds(2))
                    guard accepts() else { return }
                    // For an unknown sent operation, start only schedules the
                    // server's read-only reconciliation of the same attempt.
                    current = awaitingRemoteResult
                        ? try await client.start(sessionID: sessionID)
                        : try await client.current(sessionID: sessionID)
                    guard accepts() else { return }
                    preparation = current
                }
                guard accepts() else { return }
                if current?.isReady == true {
                    await didPrepare()
                    return
                }
            } catch is CancellationError {
                return
            } catch {
                guard accepts() else { return }
                issue = ClientSessionPreparation.requestFailureDetail(error)
            }
            // A terminal non-ready outcome or a transport failure is retried
            // automatically. The reason stays visible until the authoritative
            // snapshot turns ready and the owning surface disappears.
            try? await Task.sleep(for: backoff[min(retryIndex, backoff.count - 1)])
            retryIndex = min(retryIndex + 1, backoff.count - 1)
        }
    }
}
