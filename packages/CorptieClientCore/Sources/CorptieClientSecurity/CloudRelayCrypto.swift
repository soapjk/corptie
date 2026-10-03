import CryptoKit
import Foundation

public enum CloudRelayRole: UInt8, Sendable {
    case mobile = 1
    case mac = 2

    var peer: Self { self == .mobile ? .mac : .mobile }
    var directionMarker: UInt32 { self == .mobile ? 0x4D324D43 : 0x43324D4D }
}

public enum CloudRelayCryptoError: Error, Equatable {
    case invalidKey
    case invalidHello
    case invalidPeerRole
    case authenticationFailed
    case invalidFrame
    case connectionMismatch
    case replayedFrame
    case sequenceExhausted
}

public struct CloudRelayDeviceKey: Sendable {
    public let privateKey: Curve25519.KeyAgreement.PrivateKey

    public init() { privateKey = Curve25519.KeyAgreement.PrivateKey() }

    public init(rawRepresentation: Data) throws {
        do { privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: rawRepresentation) }
        catch { throw CloudRelayCryptoError.invalidKey }
    }

    public var privateKeyData: Data { privateKey.rawRepresentation }
    public var publicKeyData: Data { privateKey.publicKey.rawRepresentation }
    public var publicKeyBase64: String { publicKeyData.base64EncodedString() }
}

/// Authenticated ephemeral X25519 handshake. Static device keys authenticate
/// each ephemeral key; ephemeral agreement supplies forward-secret traffic keys.
public struct CloudRelayHandshake: Sendable {
    public static let protocolVersion: UInt8 = 1
    private static let helloType: UInt8 = 1
    private static let helloLength = 67

    public let connectionID: UUID
    public let role: CloudRelayRole
    private let staticPrivateKey: Curve25519.KeyAgreement.PrivateKey
    private let peerStaticPublicKey: Curve25519.KeyAgreement.PublicKey
    private let ephemeralPrivateKey: Curve25519.KeyAgreement.PrivateKey
    private let localHello: Data

    public init(
        connectionID: UUID,
        role: CloudRelayRole,
        staticPrivateKey: Curve25519.KeyAgreement.PrivateKey,
        peerStaticPublicKeyData: Data
    ) throws {
        let peerKey: Curve25519.KeyAgreement.PublicKey
        do { peerKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerStaticPublicKeyData) }
        catch { throw CloudRelayCryptoError.invalidKey }
        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let staticShared = try staticPrivateKey.sharedSecretFromKeyAgreement(with: peerKey)
        let authKey = Self.deriveHelloAuthenticationKey(staticShared: staticShared, connectionID: connectionID)
        var unsigned = Data([Self.protocolVersion, Self.helloType, role.rawValue])
        unsigned.append(ephemeral.publicKey.rawRepresentation)
        let tag = HMAC<SHA256>.authenticationCode(for: Self.helloTranscript(connectionID: connectionID, hello: unsigned), using: authKey)
        unsigned.append(contentsOf: tag)

        self.connectionID = connectionID
        self.role = role
        self.staticPrivateKey = staticPrivateKey
        self.peerStaticPublicKey = peerKey
        self.ephemeralPrivateKey = ephemeral
        self.localHello = unsigned
    }

    public func makeHello() -> Data { localHello }

    public func complete(peerHello: Data) throws -> CloudRelayCipherSession {
        guard peerHello.count == Self.helloLength,
              peerHello[0] == Self.protocolVersion,
              peerHello[1] == Self.helloType,
              let peerRole = CloudRelayRole(rawValue: peerHello[2]) else {
            throw CloudRelayCryptoError.invalidHello
        }
        guard peerRole == role.peer else { throw CloudRelayCryptoError.invalidPeerRole }
        let unsignedPeerHello = peerHello.prefix(35)
        let suppliedTag = peerHello.suffix(32)
        let staticShared = try staticPrivateKey.sharedSecretFromKeyAgreement(with: peerStaticPublicKey)
        let authKey = Self.deriveHelloAuthenticationKey(staticShared: staticShared, connectionID: connectionID)
        guard HMAC<SHA256>.isValidAuthenticationCode(
            suppliedTag,
            authenticating: Self.helloTranscript(connectionID: connectionID, hello: unsignedPeerHello),
            using: authKey
        ) else { throw CloudRelayCryptoError.authenticationFailed }

        let peerEphemeral: Curve25519.KeyAgreement.PublicKey
        do { peerEphemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerHello.subdata(in: 3..<35)) }
        catch { throw CloudRelayCryptoError.invalidHello }
        let ephemeralShared = try ephemeralPrivateKey.sharedSecretFromKeyAgreement(with: peerEphemeral)
        let orderedHellos = role == .mobile ? localHello + peerHello : peerHello + localHello
        let staticSalt = SHA256.hash(data: staticShared.data + Self.connectionData(connectionID))
        let mobileToMac = ephemeralShared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(staticSalt),
            sharedInfo: Data("corptie-relay-v1/mobile-to-mac".utf8) + orderedHellos,
            outputByteCount: 32
        )
        let macToMobile = ephemeralShared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(staticSalt),
            sharedInfo: Data("corptie-relay-v1/mac-to-mobile".utf8) + orderedHellos,
            outputByteCount: 32
        )
        return CloudRelayCipherSession(
            connectionID: connectionID,
            role: role,
            sendingKey: role == .mobile ? mobileToMac : macToMobile,
            receivingKey: role == .mobile ? macToMobile : mobileToMac
        )
    }

    private static func deriveHelloAuthenticationKey(staticShared: SharedSecret, connectionID: UUID) -> SymmetricKey {
        staticShared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: connectionData(connectionID),
            sharedInfo: Data("corptie-relay-v1/hello-auth".utf8),
            outputByteCount: 32
        )
    }

    private static func helloTranscript(connectionID: UUID, hello: some DataProtocol) -> Data {
        Data("corptie-relay-v1/hello".utf8) + connectionData(connectionID) + Data(hello)
    }

    static func connectionData(_ value: UUID) -> Data {
        var uuid = value.uuid
        return withUnsafeBytes(of: &uuid) { Data($0) }
    }
}

public actor CloudRelayCipherSession {
    public static let routingHeaderLength = 17
    public static let encryptedHeaderLength = 25

    public let connectionID: UUID
    public let role: CloudRelayRole
    private let sendingKey: SymmetricKey
    private let receivingKey: SymmetricKey
    private var sendingSequence: UInt64 = 0
    private var receivedSequence: UInt64?

    init(connectionID: UUID, role: CloudRelayRole, sendingKey: SymmetricKey, receivingKey: SymmetricKey) {
        self.connectionID = connectionID
        self.role = role
        self.sendingKey = sendingKey
        self.receivingKey = receivingKey
    }

    public func seal(_ plaintext: Data) throws -> Data {
        guard sendingSequence < UInt64.max else { throw CloudRelayCryptoError.sequenceExhausted }
        sendingSequence += 1
        let header = Self.header(connectionID: connectionID, sequence: sendingSequence)
        let nonce = try ChaChaPoly.Nonce(data: Self.nonce(marker: role.directionMarker, sequence: sendingSequence))
        let sealed = try ChaChaPoly.seal(plaintext, using: sendingKey, nonce: nonce, authenticating: header)
        return header + sealed.ciphertext + sealed.tag
    }

    public func open(_ frame: Data) throws -> Data {
        guard frame.count >= Self.encryptedHeaderLength + 16, frame[0] == CloudRelayHandshake.protocolVersion else {
            throw CloudRelayCryptoError.invalidFrame
        }
        guard frame.subdata(in: 1..<17) == CloudRelayHandshake.connectionData(connectionID) else {
            throw CloudRelayCryptoError.connectionMismatch
        }
        let sequence = frame.subdata(in: 17..<25).withUnsafeBytes { $0.loadUnaligned(as: UInt64.self).bigEndian }
        if let receivedSequence, sequence <= receivedSequence { throw CloudRelayCryptoError.replayedFrame }
        let nonce = try ChaChaPoly.Nonce(data: Self.nonce(marker: role.peer.directionMarker, sequence: sequence))
        let ciphertext = frame.subdata(in: 25..<(frame.count - 16))
        let tag = frame.suffix(16)
        let box = try ChaChaPoly.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let plaintext: Data
        do { plaintext = try ChaChaPoly.open(box, using: receivingKey, authenticating: frame.prefix(25)) }
        catch { throw CloudRelayCryptoError.authenticationFailed }
        receivedSequence = sequence
        return plaintext
    }

    private static func header(connectionID: UUID, sequence: UInt64) -> Data {
        var bigEndianSequence = sequence.bigEndian
        return Data([CloudRelayHandshake.protocolVersion])
            + CloudRelayHandshake.connectionData(connectionID)
            + withUnsafeBytes(of: &bigEndianSequence) { Data($0) }
    }

    private static func nonce(marker: UInt32, sequence: UInt64) -> Data {
        var bigEndianMarker = marker.bigEndian
        var bigEndianSequence = sequence.bigEndian
        return withUnsafeBytes(of: &bigEndianMarker) { Data($0) }
            + withUnsafeBytes(of: &bigEndianSequence) { Data($0) }
    }
}

private extension SharedSecret {
    var data: Data { withUnsafeBytes { Data($0) } }
}
