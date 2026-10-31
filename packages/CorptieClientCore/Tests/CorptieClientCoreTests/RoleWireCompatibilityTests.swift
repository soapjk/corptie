import Foundation
import Testing
@testable import CorptieClientCore

struct RoleWireCompatibilityTests {
    @Test func roleSelectionEncodesOnlyLegacyWireKeys() throws {
        let chat = ClientChatCreation(requestId: "request:chat", title: "Chat", roleId: "agent:stable", providerId: "codex-app-server")
        let chatWire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(chat)) as! [String: Any]
        #expect(chatWire["agentId"] as? String == "agent:stable")
        #expect(chatWire["roleId"] == nil)
        let work = ClientWorkCreation(requestId: "request:work", name: "Work", description: "", contributorRoleIds: ["agent:stable"])
        let workWire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(work)) as! [String: Any]
        #expect(workWire["contributorAgentIds"] as? [String] == ["agent:stable"])
        #expect(workWire["contributorRoleIds"] == nil)
        let task = ClientTaskCreation(requestId: "request:task", workId: "work:one", title: "Task", mainRoleId: "agent:stable", providerId: "codex-app-server")
        let taskWire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(task)) as! [String: Any]
        #expect(taskWire["mainAgentId"] as? String == "agent:stable")
        #expect(taskWire["mainRoleId"] == nil)
    }

    @Test func roleCollectionsDecodeOldOptionsAndKeepControlRouteStable() throws {
        let data = Data(#"{"agents":[{"id":"agent:stable","name":"Writer"}]}"#.utf8)
        let options = try JSONDecoder().decode(ClientWorkCreationOptions.self, from: data)
        #expect(options.roles.first?.id == "agent:stable")
        #expect(ClientControlKind.roles.rawValue == "agents")
    }
}
