import Foundation
import Testing
@testable import CorptieClientCore

struct DevicePairingCodeTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func code(address: String = "https://mac.local:8443", expiresAt: Double? = nil) -> DevicePairingCode {
        DevicePairingCode(address: address, serverId: "server:test", pairingId: "E60A47CD-47A0-4DC1-9786-B7F74004F848",
            pairingSecret: String(repeating: "a", count: 43), expiresAt: expiresAt ?? now.timeIntervalSince1970 * 1000 + 300_000)
    }
    @Test func roundTripKeepsOriginAndInvitation() throws {
        let original = code()
        #expect(try DevicePairingCode.decode(original.encoded(now: now), now: now) == original)
    }
    @Test func rejectInsecureAndMisleadingOrigins() {
        for address in ["http://mac.local", "https://localhost", "https://127.0.0.1", "https://0.0.0.0",
                        "https://[::]", "https://[::1]", "https://user:password@mac.local", "https://mac.local/proxy",
                        "https://mac.local?secret=value", "https://mac.local#fragment", "file:///tmp/a"] {
            #expect(throws: (any Error).self) { try code(address: address).encoded(now: now) }
        }
    }
    @Test func rejectExpiredOverlongUnknownAndNonInvitationQR() throws {
        #expect(throws: (any Error).self) { try code(expiresAt: now.timeIntervalSince1970 * 1000).encoded(now: now) }
        #expect(throws: (any Error).self) { try code(expiresAt: now.timeIntervalSince1970 * 1000 + 3_600_000).encoded(now: now) }
        let encoded = try code().encoded(now: now)
        for payload in ["https://example.com", String(repeating: "a", count: 2049),
                        encoded.replacingOccurrences(of: "corptie-device-pairing", with: "other-app"),
                        encoded.replacingOccurrences(of: "\"version\":1", with: "\"version\":2")] {
            #expect(throws: (any Error).self) { try DevicePairingCode.decode(payload, now: now) }
        }
    }
}
