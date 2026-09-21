import Foundation
import Testing
@testable import CorptieMac

struct ClientDevicesSettingsTests {
    @Test func taskCreationGrantIsExplicitAndDoesNotImplyOtherMutationAuthority() {
        let current = ["inventory.read", "messages.read"]
        let change = ClientDevicePermissionChange(permission: .createTask, enabled: true, expected: current)
        #expect(Set(change.updated) == Set(current + ["tasks.create"]))
        #expect(!change.updated.contains("sessions.commands"))
        #expect(!change.updated.contains("sessions.clear"))
        #expect(ClientDeviceCommandPermission.createTask.explanation.contains("不会自动发送首条消息"))
        let revoke = ClientDevicePermissionChange(permission: .createTask, enabled: false, expected: change.updated)
        #expect(Set(revoke.updated) == Set(current))
    }
    @Test func commandPermissionEditPreservesOtherGrantsAndDoesNotImplyClear() {
        let current = ["messages.read", "messages.write", "sessions.stop"]
        let grant = ClientDevicePermissionChange(permission: .commands, enabled: true, expected: current)
        #expect(Set(grant.updated) == Set(current + ["sessions.commands"]))
        #expect(!grant.updated.contains("sessions.clear"))
        let revoke = ClientDevicePermissionChange(permission: .commands, enabled: false,
            expected: grant.updated + ["sessions.clear"])
        #expect(Set(revoke.updated) == Set(current + ["sessions.clear"]))
        #expect(grant.expected == current)
    }

    @Test func inventoryAdvertisesExplicitCommandAuthorityWithoutGrantingIt() throws {
        let data = Data(#"{"availablePermissions":["messages.read","sessions.commands","sessions.clear"],"devices":[{"id":"d","name":"iPad","revoked":false,"permissions":["messages.read"]}],"pending":[]}"#.utf8)
        let result = try JSONDecoder().decode(ClientDeviceInventory.self, from: data)
        #expect(result.availablePermissions?.contains("sessions.commands") == true)
        #expect(result.devices.first?.permissions == ["messages.read"])
    }

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
