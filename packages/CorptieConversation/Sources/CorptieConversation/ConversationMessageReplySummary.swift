import SwiftUI
import CorptieClientCore

/// Plain text and a single explicit navigation action; no history reads or timers.
public struct ConversationMessageReplySummary: View {
    public let reply: ConversationMessageReply
    public let question: String?
    public let locate: (() -> Void)?
    public init(reply: ConversationMessageReply, question: String?, locate: (() -> Void)?) {
        self.reply = reply; self.question = question; self.locate = locate
    }
    public var body: some View {
        Button { locate?() } label: {
            Label(reply.label(question: question), systemImage: "arrow.uturn.backward")
                .font(.caption).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain).foregroundStyle(.secondary).disabled(locate == nil)
        .accessibilityHint("定位原问题")
    }
}
