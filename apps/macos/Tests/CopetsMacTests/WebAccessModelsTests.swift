import Foundation
import XCTest
@testable import CorptieMac

final class WebAccessModelsTests: XCTestCase {
    func testStatusDecodesSettingsRuntimePendingRequestsAndDevices() throws {
        let data = Data(
            """
            {
              "settings":{"enabled":true,"host":"192.168.1.10","port":47324,"httpsEnabled":true},
              "runtime":{"enabled":true,"listening":true,"host":"192.168.1.10","port":47324,"environment":"development","secure":true,
                "certificate":{"type":"local-ca","fingerprint":"AA:BB","expiresAt":"2036-07-27T00:00:00.000Z","leafFingerprint":"CC:DD","leafExpiresAt":"2026-10-25T00:00:00.000Z"}},
              "availableHosts":["192.168.1.10","10.0.0.8"],
              "pendingRequests":[{
                "id":"request-1","deviceName":"iPhone","userAgent":"Safari","sourceIp":"192.168.1.20",
                "requestedPermission":"reply","status":"pending","deviceId":null,
                "createdAt":"2026-07-26T12:00:00.000Z","expiresAt":"2026-07-26T12:10:00.000Z","resolvedAt":null
              }],
              "devices":[{
                "id":"device-1","name":"iPad","permission":"full-control","userAgent":"Safari",
                "sourceIp":"192.168.1.21","createdAt":"2026-07-26T11:00:00.000Z",
                "lastSeenAt":"2026-07-26T12:00:00.000Z","revokedAt":null
              }]
            }
            """.utf8
        )

        let status = try JSONDecoder().decode(WebAccessStatusResponse.self, from: data)
        XCTAssertTrue(status.runtime.listening)
        XCTAssertTrue(status.settings.httpsEnabled)
        XCTAssertEqual(status.runtime.certificate?.type, "local-ca")
        XCTAssertEqual(status.runtime.certificate?.leafFingerprint, "CC:DD")
        XCTAssertEqual(status.settings.host, "192.168.1.10")
        XCTAssertEqual(status.availableHosts, ["192.168.1.10", "10.0.0.8"])
        XCTAssertEqual(status.pendingRequests.first?.requestedPermission, "reply")
        XCTAssertEqual(status.devices.first?.name, "iPad")
    }

    func testDisabledLoopbackDefaultUsesTheCurrentLANAddress() {
        let settings = WebAccessSettings(enabled: false, host: "127.0.0.1", port: 47324, httpsEnabled: true)
        let resolved = webAccessSettingsUsingAvailableLAN(
            settings,
            availableHosts: ["192.168.124.19"]
        )
        XCTAssertEqual(resolved.host, "192.168.124.19")
        XCTAssertFalse(resolved.enabled)
    }

    func testEnabledAddressIsNeverSilentlyChanged() {
        let settings = WebAccessSettings(enabled: true, host: "192.168.1.10", port: 47324, httpsEnabled: true)
        XCTAssertEqual(
            webAccessSettingsUsingAvailableLAN(settings, availableHosts: ["192.168.2.10"]),
            settings
        )
    }
}
