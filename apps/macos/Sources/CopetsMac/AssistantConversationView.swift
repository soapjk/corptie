import SwiftUI

// 助手对话（03 §16.4 / 07 assistant.chat）：first-run 首屏 + 侧栏「助手」入口常驻。
// 对话式元操作——用户自然语言建目标/建工作项/查记忆，助手回执卡片。
// 规则版意图识别跑通闭环，LLM function-calling 后续接（后端已有 Claude/OpenAI 能力）。

// MARK: - 消息模型

struct AssistantMessage: Identifiable, Decodable {
    let id: UUID
    let role: String
    let content: String
    let kind: String?

    enum CodingKeys: String, CodingKey { case role, content, kind }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        id = UUID()
    }

    init(role: String, content: String, kind: String? = nil) {
        id = UUID()
        self.role = role
        self.content = content
        self.kind = kind
    }
}

struct AssistantChatResponse: Decodable {
    let sessionId: String
    let messages: [AssistantMessage]
}

// MARK: - 对话视图

struct AssistantConversationView: View {
    @StateObject private var client = EntityAPIClient.shared
    @State private var messages: [AssistantMessage] = []
    @State private var draft = ""
    @State private var isSending = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(messages) { message in
                            AssistantMessageBubble(message: message)
                                .id(message.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            Divider()

            inputBar
        }
        .frame(minWidth: 420, minHeight: 520)
        .task {
            if messages.isEmpty {
                messages = [
                    AssistantMessage(
                        role: "assistant",
                        content: "你好，我是 Corptie。我可以帮你建目标、建工作项、查记忆。试试说「建目标 重构 Corptie」。"
                    )
                ]
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("告诉 Corptie 要做什么…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .onSubmit(send)
            Button(action: send) {
                if isSending {
                    ProgressView().controlSize(.small)
                } else {
                    Text("发送")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(trimmedDraft.isEmpty || isSending)
        }
        .padding()
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func send() {
        guard !trimmedDraft.isEmpty, !isSending else { return }
        let content = trimmedDraft
        draft = ""
        isSending = true
        messages.append(AssistantMessage(role: "user", content: content))

        Task {
            let reply = await client.assistantChat(content)
            messages.append(contentsOf: reply)
            isSending = false
        }
    }
}

// MARK: - 消息气泡

struct AssistantMessageBubble: View {
    let message: AssistantMessage

    var body: some View {
        HStack(alignment: .top) {
            if message.role == "user" {
                Spacer(minLength: 48)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(message.content)
                    .textSelection(.enabled)

                if message.kind == "receipt" {
                    Label("已执行", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else if message.kind == "memory" {
                    Label("记忆", systemImage: "brain")
                        .font(.caption)
                        .foregroundStyle(.blue)
                }
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(message.role == "user" ? Color.accentColor.opacity(0.16) : Color.primary.opacity(0.06))
            )

            if message.role != "user" {
                Spacer(minLength: 48)
            }
        }
        .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
    }
}
