import SwiftUI

/// Readiness / usage semantics of the desktop `ThreadMetaView`, shared with the
/// iPad so both hosts pick the same quota window, the same colours and the same
/// wording for a Session that cannot accept messages.
public enum SessionUsagePolicy {
    public struct Window: Equatable, Sendable {
        public let usedPercent: Double?
        public let windowDurationMins: Int?
        public let resetsAt: Double?
        public init(usedPercent: Double?, windowDurationMins: Int?, resetsAt: Double?) {
            self.usedPercent = usedPercent
            self.windowDurationMins = windowDurationMins
            self.resetsAt = resetsAt
        }
    }
    public struct Snapshot: Equatable, Sendable {
        public let limitName: String?
        public let primary: Window?
        public let secondary: Window?
        public init(limitName: String?, primary: Window?, secondary: Window?) {
            self.limitName = limitName
            self.primary = primary
            self.secondary = secondary
        }
    }
    public struct Account: Equatable, Sendable {
        public let provider: String?
        public let model: String?
        public let rateLimits: Snapshot?
        public let rateLimitsByLimitId: [String: Snapshot]?
        public init(provider: String?, model: String?, rateLimits: Snapshot?, rateLimitsByLimitId: [String: Snapshot]?) {
            self.provider = provider
            self.model = model
            self.rateLimits = rateLimits
            self.rateLimitsByLimitId = rateLimitsByLimitId
        }
    }
    /// Colour band of a usage item; hosts map it onto their palette.
    public enum Tone: Equatable, Sendable { case normal, warning, critical }

    public static func remainingRateLimitPercent(_ window: Window) -> Double? {
        guard let usedPercent = window.usedPercent, usedPercent.isFinite, usedPercent >= 0 else { return nil }
        return max(0, min(100, 100 - usedPercent))
    }

    /// Codex: the bucket scoped to the current model, else the Provider-designated
    /// default bucket (never another model's zero-usage quota), else every bucket.
    /// Other providers: every bucket. The longest window wins, then the latest reset.
    public static func preferredRateLimitWindow(_ account: Account) -> Window? {
        let snapshots: [Snapshot]
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
                snapshots = [fallback]
            } else {
                snapshots = account.rateLimitsByLimitId?.values.map { $0 } ?? []
            }
        } else {
            snapshots = account.rateLimitsByLimitId?.values.map { $0 } ?? account.rateLimits.map { [$0] } ?? []
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

    /// Context tokens used, derived from `usedTokens` or the window minus what remains.
    public static func contextUsed(usedTokens: Double?, contextWindow: Double, remainingTokens: Double) -> Double {
        usedTokens ?? max(0, contextWindow - remainingTokens)
    }

    public static func contextUsedPercent(reported: Double?, used: Double, contextWindow: Double) -> Double {
        if let reported, reported.isFinite { return max(0, min(100, reported)) }
        guard contextWindow > 0 else { return 0 }
        return max(0, min(100, used / contextWindow * 100))
    }

    public static func contextTone(usedPercent: Double) -> Tone {
        if usedPercent > 70 { return .critical }
        if usedPercent > 50 { return .warning }
        return .normal
    }

    public static func quotaTone(remainingPercent: Double) -> Tone {
        if remainingPercent < 30 { return .critical }
        if remainingPercent <= 50 { return .warning }
        return .normal
    }

    public static func exactTokens(_ value: Double) -> String {
        value.formatted(.number.grouping(.automatic).precision(.fractionLength(0)))
    }

    public static func percent(_ value: Double, maximumFractionDigits: Int = 1) -> String {
        value.formatted(.number.grouping(.never).precision(.fractionLength(0...maximumFractionDigits)))
    }

    public static func quotaLabel(provider: String?) -> String {
        provider == "claude" ? "Claude quota" : "Codex quota"
    }

    private static func normalizedModelIdentifier(_ value: String?) -> String? {
        guard let value else { return nil }
        return value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}

/// Wording for a not-ready Session, keyed by the host's reason code. Values are
/// the desktop localization keys; macOS runs them through `L10n`.
public enum SessionReadinessPresentation {
    public static let readyLabel = "Ready"
    public static let notReadyLabel = "Not Ready — click for details"
    public static let defaultTitle = "Session Not Ready"
    public static let defaultMessage = "This Session cannot accept messages right now."

    public static func title(code: String?) -> String {
        switch code {
        case "BINDING_RUNTIME_VERIFYING": "Reconnecting Existing Session"
        case "PROVIDER_INITIALIZING": "Starting Provider Runtime"
        case "PROVIDER_TOOL_RECOVERY_REQUIRED", "PROVIDER_BINDING_RECOVERY_REQUIRED": "Session Recovery Required"
        default: defaultTitle
        }
    }

    public static func message(code: String?, fallback: String?) -> String {
        switch code {
        case "BINDING_RUNTIME_VERIFYING":
            "Corptie is reconnecting the existing Provider Thread. No new Thread or context rebuild is being created."
        case "PROVIDER_INITIALIZING":
            "The Provider process is starting. This does not rebuild this Session or replace its Provider Thread."
        case "PROVIDER_TOOL_RECOVERY_REQUIRED":
            "The existing Provider Thread was preserved, but its Tool schema proof is no longer trusted. Start Session Recovery explicitly to replace it."
        case "PROVIDER_BINDING_RECOVERY_REQUIRED":
            "The existing Provider Thread could not be reconnected and was preserved. Start Session Recovery explicitly to replace it."
        case "PROVIDER_SESSION_UNAVAILABLE":
            "The Provider Session no longer exists or cannot be reached. Restart this Session to continue."
        default:
            fallback.flatMap { $0.isEmpty ? nil : $0 } ?? defaultMessage
        }
    }
}

// MARK: - Views

public enum SessionMetaPalette {
    public static let connected = adaptive(light: (0.00, 0.95, 0.38), dark: (0.28, 1.00, 0.42))
    public static let disconnected = adaptive(light: (1.00, 0.12, 0.10), dark: (1.00, 0.22, 0.18))

    public static func color(for tone: SessionUsagePolicy.Tone) -> Color {
        switch tone {
        case .critical: .red
        case .warning: .yellow
        case .normal: ComposerPalette.secondaryText
        }
    }

    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        #if canImport(UIKit)
        Color(uiColor: UIColor { trait in
            let c = trait.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #else
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let c = isDark ? dark : light
            return NSColor(calibratedRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #endif
    }
}

/// The 6pt readiness light with its 12pt glow (desktop `ConnectionIndicatorLight`, static).
public struct SessionReadinessLight: View {
    private let isReady: Bool
    private let size: CGFloat
    private let glowSize: CGFloat

    public init(isReady: Bool, size: CGFloat = 6, glowSize: CGFloat = 12) {
        self.isReady = isReady
        self.size = size
        self.glowSize = glowSize
    }

    public var body: some View {
        let color = isReady ? SessionMetaPalette.connected : SessionMetaPalette.disconnected
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [color.opacity(0.42), color.opacity(0.22), color.opacity(0)],
                                     center: .center, startRadius: 0, endRadius: glowSize / 2))
                .frame(width: glowSize, height: glowSize)
            Circle()
                .fill(RadialGradient(colors: [color, color.opacity(0.88)],
                                     center: .center, startRadius: 0, endRadius: size / 2))
                .frame(width: size, height: size)
        }
        .frame(width: glowSize, height: glowSize)
    }
}

/// Title / message / code block shown when the readiness light is tapped.
public struct SessionNotReadyDetail: View {
    private let title: String
    private let message: String
    private let code: String?

    public init(title: String, message: String, code: String?) {
        self.title = title
        self.message = message
        self.code = code
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 12, weight: .bold))
            Text(message).font(.system(size: 11, weight: .medium)).fixedSize(horizontal: false, vertical: true)
            if let code, !code.isEmpty {
                Text(code).font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
    }
}

/// 10pt progress ring with a 4.5pt glyph inside (desktop `UsageProgressRing`).
public struct SessionUsageRing: View {
    private let icon: String
    private let progress: Double
    private let color: Color

    public init(icon: String, progress: Double, color: Color) {
        self.icon = icon
        self.progress = progress
        self.color = color
    }

    public var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.18), lineWidth: 1.5)
            Circle()
                .trim(from: 0, to: max(0, min(1, progress)))
                .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: icon).font(.system(size: 4.5, weight: .bold)).foregroundStyle(color)
        }
        .frame(width: 10, height: 10)
    }
}

/// Ring plus its value: `text.alignleft used/window` for context, `bolt.fill 62%` for quota.
public struct SessionUsageItem: View {
    private let icon: String
    private let value: String
    private let progress: Double
    private let color: Color
    private let numericValue: Double

    public init(icon: String, value: String, progress: Double, color: Color, numericValue: Double? = nil) {
        self.icon = icon
        self.value = value
        self.progress = progress
        self.color = color
        self.numericValue = numericValue ?? progress
    }

    public var body: some View {
        HStack(spacing: 4) {
            SessionUsageRing(icon: icon, progress: progress, color: color)
            Text(value)
                .foregroundStyle(color)
                .monospacedDigit()
                .contentTransition(.numericText(value: numericValue))
                .animation(.snappy(duration: 0.45), value: numericValue)
        }
    }
}
