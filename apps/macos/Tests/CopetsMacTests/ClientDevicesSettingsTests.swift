import Foundation
import Testing
@testable import CorptieMac

struct ClientDevicesSettingsTests {
    @Test func deviceInventoryDecodesPendingAndRevokedWithoutCredentials() throws {
        let data = Data(#"{"devices":[{"id":"d","name":"iPad","revoked":true}],"pending":[{"pairingId":"p","name":"New iPad","expiresAt":1}]}"#.utf8)
        let result = try JSONDecoder().decode(ClientDeviceInventory.self, from: data)
        #expect(result.devices.first?.revoked == true)
        #expect(result.pending.first?.id == "p")
    }

    @Test func settingsUseExplicitActionsAndLocalAuthenticatedManagement() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let view = try String(contentsOf: root.appendingPathComponent("ClientDevicesSettingsView.swift"), encoding: .utf8)
        #expect(view.contains("guard endpoint.isLoopback"))
        #expect(view.contains("BackendTransport(endpoint: endpoint, bearerToken: secret)"))
        #expect(view.contains(".onDisappear { invite = nil }"))
        #expect(!view.contains("Timer"))
        #expect(!view.contains("UserDefaults"))
        #expect(view.contains("approved: false"))
        #expect(view.contains(".alert("))
    }
}
