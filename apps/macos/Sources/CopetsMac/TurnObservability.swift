import Foundation
import SwiftUI
import CorptieClientCore
import CorptieConversation

typealias TurnDataCompleteness = ClientTurnCompleteness
typealias TurnObservabilityIdentity = ClientTurnIdentity
typealias TurnWallSummary = ClientTurnWall
typealias TurnWallPartition = ClientTurnPartition
typealias TurnTimeSummary = ClientTurnSummary

struct TurnTimeSummaryEnvelope: Decodable { let summary: TurnTimeSummary }

typealias TurnTraceSpan = ClientTurnTraceSpan
typealias TurnRawTrace = ClientTurnTrace

private struct TurnObservabilityErrorEnvelope: Decodable { let error: String }

private enum TurnObservabilityClientError: LocalizedError {
    case server(String)
    var errorDescription: String? {
        switch self { case .server(let message): message }
    }
}

enum TurnTracePresentationTier: Equatable {
    case spans
    case categoryAggregation

    static func resolve(spanCount: Int, threshold: Int = 200) -> Self {
        spanCount > threshold ? .categoryAggregation : .spans
    }
}

@MainActor
final class TurnObservabilityClient {
    static let shared = TurnObservabilityClient()
    private let baseURL = CorptieAppEnvironment.backendBaseURL

    func latestSummary(sessionId: String) async throws -> TurnTimeSummary {
        let envelope: TurnTimeSummaryEnvelope = try await get("sessions/\(encoded(sessionId))/turn-observability/latest")
        return envelope.summary
    }

    func rawTrace(turnExecutionId: String, cursor: String? = nil) async throws -> TurnRawTrace {
        var components = URLComponents(url: baseURL.appending(path: "turn-executions/\(encoded(turnExecutionId))/spans"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: "100")]
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get(url: components.url!)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await get(url: baseURL.appending(path: path))
    }
    private func get<T: Decodable>(url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(TurnObservabilityErrorEnvelope.self, from: data).error)
                ?? "服务端没有返回可用的 Trace"
            throw TurnObservabilityClientError.server(message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

/// Compatibility host for the old protocol; its content is the same shared card.
struct SessionTurnObservabilityView: View {
    let sessionId: String
    var canonicalID: String? = nil
    @State private var state = ClientDetailTurnState()
    @State private var loadedSessionID: String?
    @State private var executionID = ""
    var body: some View {
        Group {
            if loadedSessionID == sessionId, !executionID.isEmpty {
                ConversationDetailTurnCard(state: state, executionID: executionID,
                    expectedSessionIDs: [sessionId, canonicalID ?? ""],
                    readSummary: { try await TurnObservabilityClient.shared.latestSummary(sessionId: sessionId) },
                    readTrace: { try await TurnObservabilityClient.shared.rawTrace(turnExecutionId: $0, cursor: $1) })
            } else if let error = state.error {
                ConversationDetailModuleCard(title: "Turn 分析", systemImage: "point.3.connected.trianglepath.dotted") {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .task(id: sessionId) {
            state.retire(); loadedSessionID = nil; executionID = ""
            do {
                let summary = try await TurnObservabilityClient.shared.latestSummary(sessionId: sessionId)
                guard !Task.isCancelled else { return }
                try state.apply(summary, expectedSessionIDs: [sessionId, canonicalID ?? ""], executionID: summary.turnExecutionId)
                executionID = summary.turnExecutionId; loadedSessionID = sessionId
            } catch { if !Task.isCancelled { state.error = "Turn 摘要暂不可用" } }
        }
    }
}
