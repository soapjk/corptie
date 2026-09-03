import Foundation
import Combine
import UserNotifications

enum CodexResetNoticeIdentity {
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
              resetMatches(currentNotice.resetMinute, acknowledgedNotice.resetMinute) else {
            return current == acknowledged
        }

        // A forecast naturally expiring is not useful new information. A new or
        // changed forecast still becomes unread. Official reset-time changes
        // only become unread when their local calendar date changes; minute,
        // hour, and window-duration drift within the same day is noise.
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
        case (nil, nil): return true
        case let (left?, right?):
            let calendar = Calendar.autoupdatingCurrent
            let leftDate = Date(timeIntervalSince1970: TimeInterval(left * 60))
            let rightDate = Date(timeIntervalSince1970: TimeInterval(right * 60))
            return calendar.isDate(leftDate, inSameDayAs: rightDate)
        default: return false
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

enum CodexResetNotificationPolicy {
    static func shouldNotify(
        fingerprint: String,
        acknowledgedFingerprints: [String]
    ) -> Bool {
        !acknowledgedFingerprints.contains {
            CodexResetNoticeIdentity.isAcknowledged(current: fingerprint, by: $0)
        }
    }

    static func shouldNotify(
        fingerprint: String,
        acknowledgedFingerprint: String
    ) -> Bool {
        shouldNotify(
            fingerprint: fingerprint,
            acknowledgedFingerprints: acknowledgedFingerprint.isEmpty ? [] : [acknowledgedFingerprint]
        )
    }

    @MainActor
    static func notification(for usage: SessionUsageResponse) -> CodexResetSystemNotification? {
        let window = SessionUsagePresentation.preferredRateLimitWindow(usage.account)
        guard let fingerprint = CodexResetNoticeIdentity.fingerprint(
            provider: usage.account.provider,
            window: window,
            forecast: usage.resetForecast?.forecast
        ) else { return nil }
        let resetText = window?.resetsAt.map {
            L10nFormat("Plan reset: %@", Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .shortened))
        }
        let forecastText = usage.resetForecast?.forecast.map {
            L10nFormat("Tibo forecast: %@", $0.text)
        }
        return CodexResetSystemNotification(
            fingerprint: fingerprint,
            title: L10n("Codex plan update"),
            body: [resetText, forecastText].compactMap { $0 }.joined(separator: "\n")
        )
    }
}

struct CodexResetSystemNotification: Equatable {
    let fingerprint: String
    let title: String
    let body: String
}

@MainActor
final class CodexResetSystemNotificationManager {
    typealias Delivery = (CodexResetSystemNotification) -> Void

    private let client: BackendClient
    private let defaults: UserDefaults
    private let delivery: Delivery
    private var cancellable: AnyCancellable?

    static var canUseUserNotificationCenter: Bool {
        Bundle.main.bundleIdentifier != nil
            && Bundle.main.bundleURL.pathExtension.lowercased() == "app"
    }

    init(
        client: BackendClient,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults,
        delivery: Delivery? = nil
    ) {
        self.client = client
        self.defaults = defaults
        self.delivery = delivery ?? Self.deliverSystemNotification
    }

    func start() {
        cancellable = client.supplementaryDataController.$selectedSessionUsage
            .compactMap { $0 }
            .sink { [weak self] usage in self?.handle(usage) }
    }

    func stop() {
        cancellable?.cancel()
        cancellable = nil
    }

    func handle(_ usage: SessionUsageResponse) {
        guard let notification = CodexResetNotificationPolicy.notification(for: usage),
              CodexResetNotificationPolicy.shouldNotify(
                  fingerprint: notification.fingerprint,
                  acknowledgedFingerprints: CodexResetNoticeAcknowledgements.load(from: defaults)
              ) else { return }
        // Persist before asynchronous delivery so concurrent polling and
        // Session switches cannot enqueue the same system notification twice.
        CodexResetNoticeAcknowledgements.record(notification.fingerprint, in: defaults)
        delivery(notification)
    }

    private static func deliverSystemNotification(_ notification: CodexResetSystemNotification) {
        guard canUseUserNotificationCenter else {
            deliverDevelopmentNotification(notification)
            return
        }
        Task {
            let center = UNUserNotificationCenter.current()
            let allowed = (try? await center.requestAuthorization(options: [.alert, .sound])) == true
            guard allowed else { return }
            let content = UNMutableNotificationContent()
            content.title = notification.title
            content.body = notification.body
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: "codex-plan-\(notification.fingerprint)",
                content: content,
                trigger: nil
            )
            try? await center.add(request)
        }
    }

    private static func deliverDevelopmentNotification(_ notification: CodexResetSystemNotification) {
        // SwiftPM's direct Development executable is not an application bundle;
        // UNUserNotificationCenter raises an Work-C exception before Swift
        // can catch it. AppleScript still delivers a normal local macOS banner
        // and keeps the repository-prescribed direct Development launch usable.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = [
            "-e", "on run argv",
            "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e", "end run",
            "--",
            notification.title,
            notification.body
        ]
        try? process.run()
    }
}

enum SessionUsagePresentation {
    static func remainingRateLimitPercent(_ window: CodexRateLimitWindow) -> Double? {
        guard let usedPercent = window.usedPercent,
              usedPercent.isFinite,
              usedPercent >= 0 else { return nil }
        return max(0, min(100, 100 - usedPercent))
    }

    static func preferredRateLimitWindow(_ account: CodexAccountUsage) -> CodexRateLimitWindow? {
        let snapshots: [CodexRateLimitSnapshot]
        if account.provider == "codex" {
            let scoped = account.rateLimitsByLimitId?.values.first { snapshot in
                guard let model = normalizedModelIdentifier(account.model),
                      let limitName = normalizedModelIdentifier(snapshot.limitName),
                      !limitName.isEmpty else { return false }
                return model == limitName || model.contains(limitName) || limitName.contains(model)
            }
            if let scoped {
                snapshots = [scoped]
            } else if let fallback = account.rateLimits {
                // `rateLimits` is the Provider-designated default Codex bucket.
                // Do not replace it with a zero-usage quota belonging to a
                // different model (for example GPT-5.3-Codex-Spark).
                snapshots = [fallback]
            } else {
                snapshots = account.rateLimitsByLimitId?.values.map { $0 } ?? []
            }
        } else {
            snapshots = account.rateLimitsByLimitId?.values.map { $0 }
                ?? account.rateLimits.map { [$0] }
                ?? []
        }
        return snapshots
            .flatMap { [$0.primary, $0.secondary].compactMap { $0 } }
            .filter { remainingRateLimitPercent($0) != nil }
            .max { left, right in
                let leftDuration = left.windowDurationMins ?? -1
                let rightDuration = right.windowDurationMins ?? -1
                if leftDuration != rightDuration { return leftDuration < rightDuration }
                return (left.resetsAt ?? 0) < (right.resetsAt ?? 0)
            }
    }

    private static func normalizedModelIdentifier(_ value: String?) -> String? {
        guard let value else { return nil }
        return value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
