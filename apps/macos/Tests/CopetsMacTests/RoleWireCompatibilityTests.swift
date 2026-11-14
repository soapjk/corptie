import Foundation
import Testing
@testable import CorptieMac

struct RoleWireCompatibilityTests {
    @Test func roleDecodesLegacyAgentIdentityWithoutChangingListIdentity() throws {
        let data = Data(#"{"agentId":"agent:stable","agentKind":"user","name":"Research","description":"Research role","status":"available","systemPrompt":"Be precise","capabilities":[],"createdAt":"2026-01-01","updatedAt":"2026-01-01"}"#.utf8)
        let role = try JSONDecoder().decode(Role.self, from: data)
        #expect(role.roleId == "agent:stable")
        #expect(role.id == "agent:stable")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(role)) as! [String: Any]
        #expect(encoded["agentId"] as? String == role.roleId)
        #expect(encoded["roleId"] == nil)
        #expect(encoded["agentKind"] as? String == "user")
    }

    @Test func legacySnapshotCollectionUsesOneRoleDictionary() throws {
        let data = Data(#"{"sessions":[],"tasks":[],"works":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]}"#.utf8)
        let payload = try JSONDecoder().decode(ControlPlaneStatePayload.self, from: data)
        #expect(payload.roles.isEmpty)
        #expect(NormalizedAppState().roles.isEmpty)
    }
}

// The MCP management UI must accept legacy payloads without inventing runtime readiness.
struct ComputerUseWireCompatibilityTests {
    @Test func legacyPresetDoesNotImplySystemPermissionOrAnEngine() throws {
        let preset = try decode(#"{"runtime":{"status":"dependencies_available","message":"Dependencies found"},"config":{"name":"Computer Use","transport":"stdio","command":"/runtime/helper","args":[],"env":{}}}"#)
        #expect(preset.runtime.engine == nil)
        #expect(preset.runtime.permissions == nil)
        #expect(preset.runtime.engineLabel == "尚未确定")
        #expect(preset.runtime.statusLabel == "已找到依赖，操作能力待确认")
        #expect(preset.config?.command == "/runtime/helper")
    }

    @Test func officialFailureKeepsItsEngineAndReason() throws {
        let preset = try decode(#"{"runtime":{"status":"startup_failed","engine":"official","message":"Official helper failed","permissions":"unknown"},"config":null}"#)
        #expect(preset.runtime.engineLabel == "官方引擎")
        #expect(preset.runtime.statusLabel == "启动失败")
        #expect(preset.runtime.message == "Official helper failed")
        #expect(preset.runtime.permissions?.label == "尚未确认")
        #expect(preset.runtime.permissionGuidance.contains("官方 App"))
    }

    @Test func independentPermissionGuidanceUsesTheActualRequestingProcess() throws {
        let preset = try decode(#"{"runtime":{"status":"permissions_required","engine":"independent","permissions":{"screenRecording":"denied","accessibility":true}}}"#)
        #expect(preset.runtime.engineLabel == "独立引擎")
        #expect(preset.runtime.statusLabel == "需要授权")
        #expect(preset.runtime.permissions?.label == "辅助功能：已授权；屏幕录制：未授权")
        let native = try decode(#"{"runtime":{"status":"permissions_required","engine":"independent","permissions":{"screenCapture":"required","accessibility":"granted"}}}"#)
        #expect(native.runtime.permissions?.label == "辅助功能：已授权；屏幕录制：待授权")
        #expect(preset.runtime.permissionGuidance.contains("实际列出的权限申请进程"))
    }

    @Test func unknownRuntimeAndPermissionStatesRemainVisibleWithoutBreakingDecoding() throws {
        let preset = try decode(#"{"runtime":{"status":"future_failure","engine":null,"message":"Needs attention","permissions":{"screenRecording":"restricted","future":[]}}}"#)
        #expect(preset.runtime.statusLabel == "future_failure")
        #expect(preset.runtime.engineLabel == "尚未确定")
        #expect(preset.runtime.permissions?.label == "future：尚未确认；屏幕录制：restricted")
    }

    @Test func registryBuiltinFlagsAreOptionalForOldBackends() throws {
        let json = #"{"serverId":"mcp:computer-use","name":"Computer Use","url":"","transport":"stdio","args":[],"enabled":true,"toolCount":2,"assignmentCount":0,"verifiedAt":"2026-11-14","lastCheckStatus":"available","observedToolNames":[],"configRevision":1,"hasCredentials":false,"credentialNames":[]}"#
        let legacy = try JSONDecoder().decode(ManagedMcpServer.self, from: Data(json.utf8))
        #expect(legacy.builtin == nil)
        #expect(legacy.defaultEnabled == nil)
        let current = String(json.dropLast()) + #","builtin":true,"defaultEnabled":true}"#
        let builtin = try JSONDecoder().decode(ManagedMcpServer.self, from: Data(current.utf8))
        #expect(builtin.builtin == true)
        #expect(builtin.defaultEnabled == true)
        #expect(builtin.id == legacy.id)
    }

    private func decode(_ json: String) throws -> ComputerUsePresetEnvelope {
        try JSONDecoder().decode(ComputerUsePresetEnvelope.self, from: Data(json.utf8))
    }
}
