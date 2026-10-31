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
