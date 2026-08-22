import Foundation

struct SessionMessageLatencyTrace: Sendable {
    let traceId = "message:\(UUID().uuidString.lowercased())"
    let sessionId: String
    let clickedAtMs = Self.nowMs

    static var nowMs: Int64 {
        Int64((Date().timeIntervalSince1970 * 1_000).rounded())
    }

    func log(stage: String, requestStartedAtMs: Int64? = nil) {
        let atMs = Self.nowMs
        let sinceClickMs = atMs - clickedAtMs
        let sinceRequest = requestStartedAtMs.map { String(atMs - $0) } ?? "null"
        NSLog(
            "[session-message-latency] {\"traceId\":\"%@\",\"sessionId\":\"%@\",\"stage\":\"%@\",\"atMs\":%lld,\"sinceClickMs\":%lld,\"sinceRequestMs\":%@}",
            traceId,
            sessionId,
            stage,
            atMs,
            sinceClickMs,
            sinceRequest
        )
    }
}
