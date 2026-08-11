import Foundation

enum CodexResetNoticeIdentity {
    static func fingerprint(
        provider: String?,
        window: CodexRateLimitWindow?,
        forecast: CodexResetForecast?
    ) -> String? {
        guard provider == "codex" else { return nil }
        let reset = window?.resetsAt.map { String(Int($0.rounded())) } ?? "none"
        let duration = window?.windowDurationMins.map(String.init) ?? "none"
        guard reset != "none" || forecast != nil else { return nil }
        return [
            "reset=\(reset)",
            "duration=\(duration)",
            "post=\(forecast?.postId ?? "none")",
            "estimate=\(forecast?.estimateLabel ?? "none")",
            "expires=\(forecast?.expiresAt ?? "none")"
        ].joined(separator: "|")
    }
}
