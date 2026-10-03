import Foundation

public enum CloudOfflineLANDenial: Error, Equatable, Sendable {
    case revoked
    case invalidWindow
    case clockRollback
    case onlineValidationExpired
    case grantExpired
}

/// Enforces the account-backed LAN boundary independently from legacy manual pairing.
/// The window is anchored by an online Cloud validation and never slides on offline use.
public struct CloudOfflineLANPolicy: Sendable {
    public static let maximumWindow: TimeInterval = 24 * 60 * 60

    public let validatedAt: Date
    public let validationUptime: TimeInterval
    public let validUntil: Date

    public init(validatedAt: Date, validationUptime: TimeInterval, validUntil: Date) throws {
        guard validationUptime.isFinite, validationUptime >= 0,
              validUntil > validatedAt,
              validUntil.timeIntervalSince(validatedAt) <= Self.maximumWindow else {
            throw CloudOfflineLANDenial.invalidWindow
        }
        self.validatedAt = validatedAt
        self.validationUptime = validationUptime
        self.validUntil = validUntil
    }

    public func authorize(
        now: Date,
        systemUptime: TimeInterval,
        grantIssuedAt: Date,
        grantExpiresAt: Date,
        isKnownRevoked: Bool
    ) throws {
        if isKnownRevoked { throw CloudOfflineLANDenial.revoked }
        guard systemUptime.isFinite, systemUptime >= 0,
              grantIssuedAt >= validatedAt,
              grantExpiresAt > grantIssuedAt,
              grantExpiresAt.timeIntervalSince(grantIssuedAt) <= Self.maximumWindow else {
            throw CloudOfflineLANDenial.invalidWindow
        }
        // A wall clock older than the last trusted Cloud time is never accepted. Uptime is
        // also enforced while it remains monotonic; after a reboot, wall time stays authoritative.
        guard now >= validatedAt else { throw CloudOfflineLANDenial.clockRollback }
        if systemUptime >= validationUptime {
            let monotonicNow = validatedAt.addingTimeInterval(systemUptime - validationUptime)
            guard now >= monotonicNow.addingTimeInterval(-1) else { throw CloudOfflineLANDenial.clockRollback }
            guard monotonicNow < validUntil else { throw CloudOfflineLANDenial.onlineValidationExpired }
        }
        guard now < validUntil else { throw CloudOfflineLANDenial.onlineValidationExpired }
        guard now >= grantIssuedAt, now < grantExpiresAt else { throw CloudOfflineLANDenial.grantExpired }
    }
}
