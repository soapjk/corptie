import Foundation

enum CodexResetNoticeIdentity {
    private static let resetDriftToleranceMinutes = 5

    static func fingerprint(
        provider: String?,
        window: CodexRateLimitWindow?,
        forecast: CodexResetForecast?
    ) -> String? {
        guard provider == "codex" else { return nil }
        let resetMinute = window?.resetsAt.map { String(Int($0 / 60)) } ?? "none"
        let duration = window?.windowDurationMins.map(String.init) ?? "none"
        guard resetMinute != "none" || forecast != nil else { return nil }
        return [
            "v=2",
            "resetMinute=\(resetMinute)",
            "duration=\(duration)",
            "post=\(forecast?.postId ?? "none")",
            "content=\(forecast.map { stableDigest(normalizedForecastText($0.text)) } ?? "none")"
        ].joined(separator: "|")
    }

    static func isAcknowledged(current: String, by acknowledged: String) -> Bool {
        guard let currentNotice = notice(from: current),
              let acknowledgedNotice = notice(from: acknowledged),
              currentNotice.duration == acknowledgedNotice.duration,
              resetMatches(currentNotice.resetMinute, acknowledgedNotice.resetMinute) else {
            return current == acknowledged
        }

        // A forecast naturally expiring is not useful new information. A new or
        // changed forecast still becomes unread, as does a meaningful official
        // reset-time change.
        guard currentNotice.post != "none" else { return true }
        guard currentNotice.post == acknowledgedNotice.post else { return false }
        if currentNotice.version >= 2, acknowledgedNotice.version >= 2 {
            return currentNotice.content == acknowledgedNotice.content
        }
        return true
    }

    private static func notice(from fingerprint: String) -> Notice? {
        let values = Dictionary(uniqueKeysWithValues: fingerprint.split(separator: "|").compactMap { component in
            let pair = component.split(separator: "=", maxSplits: 1).map(String.init)
            return pair.count == 2 ? (pair[0], pair[1]) : nil
        })
        let version = Int(values["v"] ?? "1") ?? 1
        let resetMinute: Int?
        if let value = Int(values["resetMinute"] ?? "") {
            resetMinute = value
        } else if let seconds = Double(values["reset"] ?? "") {
            resetMinute = Int(seconds / 60)
        } else {
            resetMinute = nil
        }
        guard resetMinute != nil || values["post"] != nil else { return nil }
        return Notice(
            version: version,
            resetMinute: resetMinute,
            duration: values["duration"] ?? "none",
            post: values["post"] ?? "none",
            content: values["content"] ?? "none"
        )
    }

    private static func resetMatches(_ left: Int?, _ right: Int?) -> Bool {
        switch (left, right) {
        case (nil, nil): true
        case let (left?, right?): abs(left - right) <= resetDriftToleranceMinutes
        default: false
        }
    }

    private static func normalizedForecastText(_ value: String) -> String {
        value.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func stableDigest(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(hash, radix: 16)
    }

    private struct Notice {
        let version: Int
        let resetMinute: Int?
        let duration: String
        let post: String
        let content: String
    }
}

enum CodexResetNoticeAcknowledgements {
    static let maximumCount = 32
    static let legacyStorageKey = "codexResetNoticeAcknowledgedFingerprint"
    static let storageKey = "codexResetNoticeAcknowledgedFingerprintsV2"

    static func decoded(_ encoded: String, legacy: String = "") -> [String] {
        var values = (try? JSONDecoder().decode([String].self, from: Data(encoded.utf8))) ?? []
        if !legacy.isEmpty { values.append(legacy) }
        var seen = Set<String>()
        return Array(values.reversed().filter { seen.insert($0).inserted }.reversed())
    }

    static func adding(_ fingerprint: String, to encoded: String, legacy: String = "") -> String {
        var values = decoded(encoded, legacy: legacy).filter { $0 != fingerprint }
        values.append(fingerprint)
        values = Array(values.suffix(maximumCount))
        guard let data = try? JSONEncoder().encode(values) else { return encoded }
        return String(decoding: data, as: UTF8.self)
    }

    @MainActor
    static func load(from defaults: UserDefaults = CorptieAppEnvironment.userDefaults) -> [String] {
        decoded(
            defaults.string(forKey: storageKey) ?? "",
            legacy: defaults.string(forKey: legacyStorageKey) ?? ""
        )
    }

    @MainActor
    static func record(_ fingerprint: String, in defaults: UserDefaults = CorptieAppEnvironment.userDefaults) {
        let encoded = adding(
            fingerprint,
            to: defaults.string(forKey: storageKey) ?? "",
            legacy: defaults.string(forKey: legacyStorageKey) ?? ""
        )
        defaults.set(encoded, forKey: storageKey)
        defaults.set(fingerprint, forKey: legacyStorageKey)
    }
}

enum CodexResetNoticePresentation {
    enum ManualAction: Equatable {
        case present
        case rearm
    }

    static let automaticPresentationDelay: Duration = .milliseconds(350)
    static let rearmDelay: Duration = .milliseconds(60)

    static func manualAction(isPresented: Bool) -> ManualAction {
        isPresented ? .rearm : .present
    }

    static func shouldPresent(
        fingerprint: String,
        acknowledgedFingerprints: [String]
    ) -> Bool {
        !acknowledgedFingerprints.contains {
            CodexResetNoticeIdentity.isAcknowledged(current: fingerprint, by: $0)
        }
    }

    static func shouldAutomaticallyPresent(
        fingerprint: String,
        lastAutomaticallyPresentedFingerprint: String?,
        acknowledgedFingerprints: [String]
    ) -> Bool {
        fingerprint != lastAutomaticallyPresentedFingerprint
            && shouldPresent(
                fingerprint: fingerprint,
                acknowledgedFingerprints: acknowledgedFingerprints
            )
    }

    static func shouldPresent(
        fingerprint: String,
        acknowledgedFingerprint: String
    ) -> Bool {
        shouldPresent(
            fingerprint: fingerprint,
            acknowledgedFingerprints: acknowledgedFingerprint.isEmpty ? [] : [acknowledgedFingerprint]
        )
    }
}

enum SessionUsagePresentation {
    static func preferredRateLimitWindow(_ account: CodexAccountUsage) -> CodexRateLimitWindow? {
        var snapshots = account.rateLimitsByLimitId?.values.map { $0 } ?? []
        if let fallback = account.rateLimits {
            snapshots.append(fallback)
        }
        return snapshots
            .flatMap { [$0.primary, $0.secondary].compactMap { $0 } }
            .max { left, right in
                let leftDuration = left.windowDurationMins ?? -1
                let rightDuration = right.windowDurationMins ?? -1
                if leftDuration != rightDuration { return leftDuration < rightDuration }
                return (left.resetsAt ?? 0) < (right.resetsAt ?? 0)
            }
    }
}
