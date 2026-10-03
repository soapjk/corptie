import Foundation
import Testing
@testable import CorptieClientSecurity

@Suite("Cloud offline LAN policy")
struct CloudOfflineLANPolicyTests {
    private let start = Date(timeIntervalSince1970: 2_000_000_000)

    @Test("accepts only inside the fixed 24-hour online validation window")
    func fixedBoundary() throws {
        let policy = try CloudOfflineLANPolicy(
            validatedAt: start, validationUptime: 10_000,
            validUntil: start.addingTimeInterval(24 * 60 * 60)
        )
        try policy.authorize(
            now: start.addingTimeInterval(86_399), systemUptime: 96_399,
            grantIssuedAt: start, grantExpiresAt: start.addingTimeInterval(86_400), isKnownRevoked: false
        )
        #expect(throws: CloudOfflineLANDenial.onlineValidationExpired) {
            try policy.authorize(
                now: start.addingTimeInterval(86_400), systemUptime: 96_400,
                grantIssuedAt: start, grantExpiresAt: start.addingTimeInterval(86_400), isKnownRevoked: false
            )
        }
    }

    @Test("offline use cannot slide or extend the grant")
    func nonSlidingGrant() throws {
        let policy = try CloudOfflineLANPolicy(
            validatedAt: start, validationUptime: 100,
            validUntil: start.addingTimeInterval(86_400)
        )
        #expect(throws: CloudOfflineLANDenial.grantExpired) {
            try policy.authorize(
                now: start.addingTimeInterval(3_601), systemUptime: 3_701,
                grantIssuedAt: start, grantExpiresAt: start.addingTimeInterval(3_600), isKnownRevoked: false
            )
        }
        #expect(throws: CloudOfflineLANDenial.invalidWindow) {
            try policy.authorize(
                now: start, systemUptime: 100, grantIssuedAt: start,
                grantExpiresAt: start.addingTimeInterval(86_401), isKnownRevoked: false
            )
        }
    }

    @Test("known revocation and clock rollback fail closed")
    func revocationAndClockSafety() throws {
        let policy = try CloudOfflineLANPolicy(
            validatedAt: start, validationUptime: 1_000,
            validUntil: start.addingTimeInterval(86_400)
        )
        #expect(throws: CloudOfflineLANDenial.revoked) {
            try policy.authorize(
                now: start.addingTimeInterval(10), systemUptime: 1_010,
                grantIssuedAt: start, grantExpiresAt: start.addingTimeInterval(100), isKnownRevoked: true
            )
        }
        #expect(throws: CloudOfflineLANDenial.clockRollback) {
            try policy.authorize(
                now: start.addingTimeInterval(5), systemUptime: 1_010,
                grantIssuedAt: start, grantExpiresAt: start.addingTimeInterval(100), isKnownRevoked: false
            )
        }
        #expect(throws: CloudOfflineLANDenial.clockRollback) {
            try policy.authorize(
                now: start.addingTimeInterval(-1), systemUptime: 10,
                grantIssuedAt: start, grantExpiresAt: start.addingTimeInterval(100), isKnownRevoked: false
            )
        }
    }
}
