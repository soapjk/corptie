import SwiftUI
import CorptieClientCore
import CoreTransferable
import UniformTypeIdentifiers

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
    let singleTap: () -> Void
    let dragScope: String?

    public init(items: [ClientQuickMessage], enabled: Bool, dragScope: String? = nil,
                singleTap: @escaping () -> Void = {}, send: @escaping (String) -> Void) {
        self.items = items; self.enabled = enabled; self.send = send
        self.dragScope = dragScope; self.singleTap = singleTap
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            if #available(iOS 26.0, macOS 26.0, *) {
                GlassEffectContainer(spacing: 6) { chips }
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
                    chip(item)
                    .disabled(!enabled)
                    .accessibilityLabel("发送快捷消息：\(item.text)")
                    #if os(iOS)
                    .accessibilityHint("双击发送快捷消息，或长按拖到消息列表发送")
                    #else
                    .accessibilityHint(item.scope == "task" ? "当前 Task 的常用消息"
                        : item.scope == "session" ? "当前会话的常用消息" : "通用快捷消息")
                    #endif
                    .accessibilityIdentifier("quick-message-\(item.id)")
                }
            }
            .padding(.horizontal, 3).padding(.vertical, 3)
    }

    private func label(_ item: ClientQuickMessage) -> some View {
        Text(item.text)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1).fixedSize()
            .padding(.horizontal, 9).frame(height: 24)
            .platformGlassSurface(in: Capsule(), interactive: true)
    }

    @ViewBuilder private func chip(_ item: ClientQuickMessage) -> some View {
        #if os(iOS)
        let content = label(item)
            .frame(minHeight: 44).contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
            .gesture(TapGesture(count: 2).exclusively(before: TapGesture(count: 1)).onEnded { value in
                let count: Int
                switch value { case .first: count = 2; case .second: count = 1 }
                switch ConversationQuickMessageDrag.tapAction(count: count, enabled: enabled) {
                case .send: send(item.text)
                case .hint: singleTap()
                case .none: break
                }
            })
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if enabled { send(item.text) } }
            .accessibilityHint("双击发送快捷消息，或长按拖到消息列表发送")
        if let dragScope, enabled {
            content.draggable(ConversationQuickMessageDrag(scope: dragScope, text: item.text))
        } else { content }
        #else
        Button { send(item.text) } label: { label(item) }.buttonStyle(.plain)
        #endif
    }
}

/// A dedicated type prevents ordinary text/file drops from becoming sends.
/// Scope binds a drag to its originating host, device and Session.
public struct ConversationQuickMessageDrag: Codable, Transferable, Sendable, Equatable {
    public enum TapAction: Equatable { case none, hint, send }
    public static func tapAction(count: Int, enabled: Bool) -> TapAction {
        guard enabled else { return .none }
        return count == 2 ? .send : count == 1 ? .hint : .none
    }
    public let scope: String
    public let text: String
    public init(scope: String, text: String) { self.scope = scope; self.text = text }
    public static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: UTType(exportedAs: "com.corptie.quick-message"))
    }

    public func acceptedText(scope: String, enabled: Bool, location: CGPoint,
                             viewport: CGSize, topInset: CGFloat, bottomInset: CGFloat) -> String? {
        guard enabled, !scope.isEmpty, self.scope == scope, bottomInset > 0,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 16000,
              location.x >= 0, location.x < viewport.width,
              location.y >= max(0, topInset), location.y < viewport.height - max(0, bottomInset)
        else { return nil }
        return text
    }
}
