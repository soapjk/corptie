import Foundation
import CoreImage
import Testing
import CorptieClientCore
@testable import CorptieMac

struct DevicePairingQRTests {
    @Test func certificateBearingQRDecodesWithoutSystemTrustInstallation() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", root.appendingPathComponent("packages/CorptieClientCore/Tests/CorptieClientCoreTests/TLSFixture.mjs").path]
        process.standardOutput = pipe
        try process.run()
        defer { process.terminate(); process.waitUntilExit() }
        struct Fixture: Decodable { let certificate: String }
        let fixture = try JSONDecoder().decode(Fixture.self, from: pipe.fileHandleForReading.availableData)
        let code = DevicePairingCode(address: "https://192.168.1.2:54321", serverId: UUID().uuidString,
            pairingId: UUID().uuidString, pairingSecret: String(repeating: "a", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000, certificate: fixture.certificate)
        let image = try #require(DevicePairingQRImage.make(code.encoded()))
        let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(),
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let scanned = try #require((detector.features(in: CIImage(cgImage: image)).first as? CIQRCodeFeature)?.messageString)
        #expect(try DevicePairingCode.decode(scanned) == code)
    }

    @Test func generatedQRDecodesToTheExactInvitation() throws {
        let code = DevicePairingCode(address: "https://mac.local:8443", serverId: "server:qr-test",
            pairingId: UUID().uuidString, pairingSecret: String(repeating: "a", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000)
        let payload = try code.encoded()
        let image = try #require(DevicePairingQRImage.make(payload))
        let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(),
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let features = detector.features(in: CIImage(cgImage: image))
        let scanned = try #require((features.first as? CIQRCodeFeature)?.messageString)
        #expect(try DevicePairingCode.decode(scanned) == code)
    }
}
