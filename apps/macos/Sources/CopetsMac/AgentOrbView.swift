import SwiftUI

// AgentOrbView：浮球 Agent 化后的球本体（03 §17.3.2，净新增）。
// 复用现有 DefaultInitialAvatarView 的头像配色（familySeed 派生渐变，D-浮球-4 沿用）。
// 尺寸对齐现有浮球：头像 52pt / 内容 72pt / 窗口 88×88。

// MARK: - provider 徽标（右上角）

struct AgentProviderBadge: View {
    let provider: String?

    var body: some View {
        if let color = providerColor {
            Circle()
                .fill(color)
                .frame(width: 14, height: 14)
                .overlay(Circle().strokeBorder(Color.white.opacity(0.85), lineWidth: 1.5))
        }
    }

    // provider 品牌色（设计 §17.3.2 新增；现有代码无此映射，用系统橙/绿近似）
    // claude_code = 橙、codex = 绿；harness（平台助手）与 nil 不显示徽标
    private var providerColor: Color? {
        switch provider {
        case "claude_code": .orange
        case "codex": .green
        default: nil
        }
    }
}

// MARK: - 角标（待处理项数）

struct AgentOrbBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .frame(minWidth: 18, minHeight: 18)
            .background(Capsule().fill(.red))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.9), lineWidth: 1.5))
    }
}

// MARK: - 球本体

struct AgentOrbView: View {
    let agent: Agent
    var badgeCount: Int = 0
    var onTap: (() -> Void)? = nil
    var onDoubleTap: (() -> Void)? = nil

    var body: some View {
        ZStack {
            DefaultInitialAvatarView(
                familySeed: agent.name,
                variationSeed: agent.agentId,
                initials: DefaultAvatarInitials.make(from: agent.name),
                size: 52
            )
            .frame(width: 72, height: 72)

            AgentProviderBadge(provider: agent.provider)
                .offset(x: 24, y: -24)

            if badgeCount > 0 {
                AgentOrbBadge(count: badgeCount)
                    .offset(x: 26, y: 26)
            }
        }
        .frame(width: 88, height: 88)
        .contentShape(Rectangle())
        .onTapGesture(count: 1) { onTap?() }
        .onTapGesture(count: 2) { onDoubleTap?() }
    }
}

// MARK: - 演示视图（预览）

struct AgentOrbDemoView: View {
    var body: some View {
        VStack(spacing: 24) {
            Text("Agent 浮球演示")
                .font(.title3.bold())

            HStack(spacing: 32) {
                VStack(spacing: 8) {
                    AgentOrbView(agent: Self.assistant, badgeCount: 3)
                    Text("助手（harness）· 角标 3")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                VStack(spacing: 8) {
                    AgentOrbView(agent: Self.contributor, badgeCount: 0)
                    Text("独立贡献者（codex）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                VStack(spacing: 8) {
                    AgentOrbView(agent: Self.claude, badgeCount: 1)
                    Text("独立贡献者（claude_code）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(32)
        .frame(width: 480, height: 240)
    }

    static let assistant = Agent(
        agentId: "assistant", name: "Corptie", description: "", role: "assistant",
        status: "available", provider: "harness", systemPrompt: "", capabilities: [],
        currentSessionId: nil, createdAt: "", updatedAt: ""
    )
    static let contributor = Agent(
        agentId: "backend-dev", name: "后端开发", description: "", role: "independentContributor",
        status: "available", provider: "codex", systemPrompt: "", capabilities: [],
        currentSessionId: nil, createdAt: "", updatedAt: ""
    )
    static let claude = Agent(
        agentId: "frontend-dev", name: "前端开发", description: "", role: "independentContributor",
        status: "busy", provider: "claude_code", systemPrompt: "", capabilities: [],
        currentSessionId: nil, createdAt: "", updatedAt: ""
    )
}
