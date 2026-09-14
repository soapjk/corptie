import Foundation
import CoreImage
import Testing
import CorptieClientCore
@testable import CorptieMac

struct DevicePairingQRTests {
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
