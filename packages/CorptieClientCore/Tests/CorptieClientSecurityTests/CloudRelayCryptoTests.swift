import CryptoKit
import Foundation
import Testing
@testable import CorptieClientSecurity

struct CloudRelayCryptoTests {
    @Test func authenticatedHandshakeCreatesBidirectionalOpaqueFrames() async throws {
        let connectionID = UUID()
        let mobileKey = CloudRelayDeviceKey()
        let macKey = CloudRelayDeviceKey()
        let mobile = try CloudRelayHandshake(
            connectionID: connectionID,
            role: .mobile,
            staticPrivateKey: mobileKey.privateKey,
            peerStaticPublicKeyData: macKey.publicKeyData
        )
        let mac = try CloudRelayHandshake(
            connectionID: connectionID,
            role: .mac,
            staticPrivateKey: macKey.privateKey,
            peerStaticPublicKeyData: mobileKey.publicKeyData
        )
        let mobileSession = try mobile.complete(peerHello: mac.makeHello())
        let macSession = try mac.complete(peerHello: mobile.makeHello())

        let command = Data("sensitive command".utf8)
        let outbound = try await mobileSession.seal(command)
        #expect(!outbound.contains(command))
        #expect(try await macSession.open(outbound) == command)

        let response = Data("sensitive response".utf8)
        let inbound = try await macSession.seal(response)
        #expect(try await mobileSession.open(inbound) == response)
    }

    @Test func handshakeRejectsTamperedEphemeralIdentityProof() throws {
        let connectionID = UUID()
        let mobileKey = CloudRelayDeviceKey()
        let macKey = CloudRelayDeviceKey()
        let mobile = try CloudRelayHandshake(
            connectionID: connectionID,
            role: .mobile,
            staticPrivateKey: mobileKey.privateKey,
            peerStaticPublicKeyData: macKey.publicKeyData
        )
        let mac = try CloudRelayHandshake(
            connectionID: connectionID,
            role: .mac,
            staticPrivateKey: macKey.privateKey,
            peerStaticPublicKeyData: mobileKey.publicKeyData
        )
        var tampered = mac.makeHello()
        tampered[10] ^= 0x01
        #expect(throws: CloudRelayCryptoError.authenticationFailed) {
            try mobile.complete(peerHello: tampered)
        }
    }

    @Test func encryptedFramesRejectTamperingReplayAndWrongConnection() async throws {
        let first = try makeSessions(connectionID: UUID())
        let frame = try await first.mobile.seal(Data("one".utf8))
        #expect(try await first.mac.open(frame) == Data("one".utf8))
        await #expect(throws: CloudRelayCryptoError.replayedFrame) {
            try await first.mac.open(frame)
        }

        let second = try makeSessions(connectionID: UUID())
        await #expect(throws: CloudRelayCryptoError.connectionMismatch) {
            try await second.mac.open(frame)
        }

        var tampered = try await first.mobile.seal(Data("two".utf8))
        tampered[tampered.count - 1] ^= 0x01
        await #expect(throws: CloudRelayCryptoError.authenticationFailed) {
            try await first.mac.open(tampered)
        }
    }

    private func makeSessions(connectionID: UUID) throws -> (
        mobile: CloudRelayCipherSession,
        mac: CloudRelayCipherSession
    ) {
        let mobileKey = CloudRelayDeviceKey()
        let macKey = CloudRelayDeviceKey()
        let mobile = try CloudRelayHandshake(
            connectionID: connectionID,
            role: .mobile,
            staticPrivateKey: mobileKey.privateKey,
            peerStaticPublicKeyData: macKey.publicKeyData
        )
        let mac = try CloudRelayHandshake(
            connectionID: connectionID,
            role: .mac,
            staticPrivateKey: macKey.privateKey,
            peerStaticPublicKeyData: mobileKey.publicKeyData
        )
        return (
            try mobile.complete(peerHello: mac.makeHello()),
            try mac.complete(peerHello: mobile.makeHello())
        )
    }
}
