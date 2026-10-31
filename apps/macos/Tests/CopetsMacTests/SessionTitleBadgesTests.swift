import AppKit
import Combine
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct SessionTitleBadgesTests {
    private func session(provider: String = "codex-app-server", agent: String? = "agent:custom") throws -> TaskSession {
        let agentJSON = agent.map { "\"\($0)\"" } ?? "null"
        return try JSONDecoder().decode(TaskSession.self, from: Data("""
        {"id":"session:title-test","title":"会话","agent":"Legacy Provider","agentId":\(agentJSON),
         "status":"running","progress":0,"summary":"","updatedAt":"2026-10-31T00:00:00Z","accent":"cyan",
         "external":{"provider":"\(provider)","currentModel":"model-v1"}}
        """.utf8))
    }

    private func role() -> Role {
        Role(roleId: "agent:custom", name: "自定义助手", description: "", status: "idle", systemPrompt: "",
              capabilities: [], avatarPath: "/tmp/custom-avatar.png", createdAt: "", updatedAt: "")
    }

    @Test func allProvidersUseTheBoundRoleAndCurrentModel() throws {
        for provider in ["codex-app-server", "claude-sdk", "openclacky", "future-provider"] {
            let session = try session(provider: provider)
            let identity = SessionTitleIdentity.resolve(.init(session: session), roles: [role().id: role()], providers: [])
            #expect(identity.providerID == provider)
            #expect(identity.providerHelp == "\(provider) · model-v1")
            #expect(identity.roleHelp == "自定义助手")
            #expect(identity.avatarPath == "/tmp/custom-avatar.png")
        }
        let unbound = SessionTitleIdentity.resolve(.init(session: try session(agent: nil)), roles: [:], providers: [])
        #expect(unbound.roleID == nil)
        let missing = SessionTitleIdentity.resolve(.init(session: try session()), roles: [:], providers: [])
        #expect(missing.roleID == "agent:custom")
        #expect(missing.avatarPath == nil)
    }

    @Test func identityStreamTracksSwitchesAndAvatarEditsWithoutUnrelatedInvalidations() throws {
        let original = try session()
        var state = NormalizedAppState(sessions: [original.id: original], roles: [role().id: role()])
        let states = CurrentValueSubject<NormalizedAppState, Never>(state)
        let providers = CurrentValueSubject<[AgentProviderDescriptor], Never>([])
        var values: [SessionTitleIdentity] = []
        let subscription = SessionTitleIdentity.updates(session: original, state: states.eraseToAnyPublisher(),
            providers: providers.eraseToAnyPublisher()).sink { values.append($0) }
        #expect(values.count == 1)
        state.sessions[original.id]?.executionStatus = "queued"
        states.send(state)
        state.roles[role().id]?.status = "busy"
        states.send(state)
        #expect(values.count == 1)
        state.sessions[original.id]?.external?.currentModel = "model-v2"
        states.send(state)
        #expect(values.last?.model == "model-v2")
        state.sessions[original.id] = try session(provider: "claude-sdk")
        states.send(state)
        #expect(values.last?.providerID == "claude-sdk")
        state.roles[role().id]?.avatarPath = "/tmp/new-avatar.png"
        states.send(state)
        #expect(values.last?.avatarPath == "/tmp/new-avatar.png")
        state.roles.removeValue(forKey: role().id)
        states.send(state)
        #expect(values.last?.avatarPath == nil)
        #expect(values.count == 5)
        withExtendedLifetime(subscription) {}
    }

    @Test func longTitlesKeepBothIconsVisibleAtNarrowWidths() throws {
        let identity = SessionTitleIdentity.resolve(.init(session: try session()), roles: [:], providers: [])
        for width: CGFloat in [100, 160, 264] {
            let host = NSHostingView(rootView: HStack(spacing: 4) {
                Text(String(repeating: "很长的会话标题", count: 20)).lineLimit(1)
                SessionTitleIdentityIcons(identity: identity)
            }.frame(width: width))
            host.frame.size = CGSize(width: width, height: 24)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.width <= width + 1)
            #expect(host.fittingSize.height <= 24)
        }
        let icons = NSHostingView(rootView: SessionTitleIdentityIcons(identity: identity))
        #expect(icons.fittingSize == CGSize(width: 32, height: 14))
    }
}
