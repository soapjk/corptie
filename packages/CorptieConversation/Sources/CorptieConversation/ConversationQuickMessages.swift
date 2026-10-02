import SwiftUI
import CorptieClientCore

/// Independent, compact glass chips above the composer. No transcript reads,
/// per-chip observation, layout animation, or full-width material layer.
public struct ConversationQuickMessages: View {
    #if os(iOS)
    private static let rowHeight: CGFloat = 50
    #else
    private static let rowHeight: CGFloat = 30
    #endif
    let items: [ClientQuickMessage]
    let enabled: Bool
    let send: (String) -> Void

    public init(items: [ClientQuickMessage], enabled: Bool, send: @escaping (String) -> Void) {
        self.items = items; self.enabled = enabled; self.send = send
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            if #available(iOS 26.0, macOS 26.0, *) {
                GlassEffectContainer(spacing: 0) { chips }
            } else {
                chips
            }
        }
        .frame(height: Self.rowHeight)
        .accessibilityIdentifier("conversation-quick-messages")
    }

    private var chips: some View {
        HStack(spacing: 6) {
                ForEach(items) { item in
                    Button { send(item.text) } label: {
                        Text(item.text)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1).fixedSize()
                            .padding(.horizontal, 9).frame(height: 24)
                            .platformGlassSurface(in: Capsule(), interactive: true)
                            #if os(iOS)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                            #endif
                    }
                    .buttonStyle(.plain)
                    .disabled(!enabled)
                    .accessibilityLabel("发送快捷消息：\(item.text)")
                    .accessibilityHint(item.scope == "task" ? "当前 Task 的常用消息"
                        : item.scope == "session" ? "当前会话的常用消息" : "通用快捷消息")
                    .accessibilityIdentifier("quick-message-\(item.id)")
                }
            }
            .padding(.horizontal, 3).padding(.vertical, 3)
    }
}
