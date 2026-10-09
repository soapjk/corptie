#if DEBUG
import SwiftUI
import UIKit
import CorptieClientCore

/// UI automation uses actual product cards and actual touch/keyboard handling.
/// No account restore, relay, LAN requests, sends or attachment uploads occur.
struct PadStandardTimelineFixture: View {
    @State private var model = StandardTimelineFixtureModel()
    @State private var opened = false
    @State private var keyboard = PadKeyboardViewport()
    var body: some View {
        NavigationStack {
            if opened {
                ConversationView(connection: model.connection, workspace: model.workspace,
                    sessionID: "standard-fixture", messageImages: model.messageImages,
                    onBack: { opened = false }, onOpenDetail: {}, onOpenWorktrees: {}, standardTimeline: true)
                    .environment(\.padKeyboardViewport, keyboard)
            } else {
                Button("Open local fixture") { opened = true }
                    .accessibilityIdentifier("standard-fixture-open")
            }
        }
        .overlay(alignment: .trailing) {
            if opened {
                VStack(spacing: 12) {
                    Button("发") { model.sendLocalDraft() }
                        .accessibilityIdentifier("standard-fixture-send")
                    Button("＋") { model.appendReply() }
                        .accessibilityIdentifier("standard-fixture-append")
                    Button("流") { model.streamReply() }
                        .accessibilityIdentifier("standard-fixture-stream")
                    Button("图") { model.appendRichReply() }
                        .accessibilityIdentifier("standard-fixture-rich")
                }.padding(12).background(.regularMaterial)
            }
        }
        .background(PadKeyboardDismissal())
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) {
            updateKeyboard($0, changing: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) {
            updateKeyboard($0, changing: false)
        }
    }
    private func updateKeyboard(_ notification: Notification, changing: Bool) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: \.isKeyWindow) else { return }
        keyboard.isChanging = changing
        keyboard.isVisible = PadNativeTimelineGeometry.keyboardIntersectsWindow(
            frame: window.convert(frame, from: window.screen.coordinateSpace), bounds: window.bounds)
        keyboard.revision &+= 1
    }
}
@MainActor private final class StandardTimelineFixtureModel {
    let connection: PadConnection
    let workspace: PadWorkspace
    let messageImages = PadMessageImageStore()
    private var nextReply = 180
    private var stream: Task<Void, Never>?
    private func decode(_ row: [String: Any]) -> ClientMessage {
        try! JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: row))
    }
    func sendLocalDraft() {
        let text = workspace.drafts["standard-fixture"] ?? ""
        workspace.drafts["standard-fixture"] = ""
        workspace.outgoingMessages["standard-fixture", default: []].append(
            ClientMessage(id: "standard:\(nextReply)", text: text.isEmpty ? "本地发送验收" : text))
        workspace.scrollRequest += 1
        nextReply += 1
    }
    func appendRichReply() {
        workspace.messages.append(decode(["id": "fixture:tool:\(nextReply)", "turnId": "turn:rich:\(nextReply)",
            "type": "commandExecution", "title": "本地验收执行过程", "text": "No command was executed.\nfixture output",
            "status": "completed", "turnStatus": "completed"]))
        workspace.messages.append(decode(["id": "standard:\(nextReply)", "turnId": "turn:rich:\(nextReply)",
            "type": "userMessage", "text": "本地图片卡片", "images": [["managedPath": "fixture/image.png", "mimeType": "image/png"]]]))
        nextReply += 1
    }
    func streamReply() {
        stream?.cancel()
        let id = nextReply
        appendReply()
        stream = Task { [weak self] in
            for step in 1...12 {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                guard let self, let index = workspace.messages.firstIndex(where: { $0.id == "standard:\(id)" }) else { return }
                workspace.messages[index] = decode(["id": "standard:\(id)", "turnId": "turn:\(id)",
                    "type": "agentMessage", "text": String(repeating: "流式内容逐步增长。", count: step * 3),
                    "presentationRole": "final_answer"])
            }
        }
    }
    func appendReply() {
        let row: [String: Any] = ["id": "standard:\(nextReply)", "turnId": "turn:\(nextReply)",
            "type": "agentMessage", "text": String(repeating: "新增回复用于验收最新消息跟随。", count: 8),
            "presentationRole": "final_answer"]
        nextReply += 1
        workspace.messages.append(try! JSONDecoder().decode(ClientMessage.self,
            from: JSONSerialization.data(withJSONObject: row)))
    }
    init() {
        let suite = "corptie.standard.fixture.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let image = UIImage(systemName: "photo")!.pngData()!
        let transport = BackendTransport(endpoint: try! BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { request in
                guard let url = request.url, url.path.hasSuffix("/images") else { throw CancellationError() }
                return (image, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                    headerFields: ["Content-Type": "image/png"])!)
            }, bytes: { _ in throw CancellationError() })
        connection = PadConnection(transportOverride: transport)
        connection.serverID = suite
        workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "standard-fixture"
        workspace.lastTimelineRevision = 1
        let rows: [[String: Any]] = (0..<180).map { index in
            ["id": "standard:\(index)", "turnId": "turn:\(index)",
             "type": index % 4 == 0 ? "userMessage" : "agentMessage",
             "text": index % 4 == 0 ? "用户消息 \(index)" : """
             ## 真实历史卡片 \(index)
             \(String(repeating: "长文本用于测试稳定排版、真实拖动和单元格间隙。", count: index % 5 + 1))

             | 项目 | 数值 | 说明 |
             | --- | ---: | --- |
             | BTC | 12345 | 复杂 Markdown 表格 |
             | ETH | 678 | 自动换行内容 |

             ```swift
             let value = \(index)
             ```
             """, "presentationRole": "final_answer"]
        }
        workspace.messages = try! JSONDecoder().decode([ClientMessage].self,
            from: JSONSerialization.data(withJSONObject: rows))
        if ProcessInfo.processInfo.environment["CORPTIE_STATUS_LIGHT_FIXTURE"] == "1" {
            let lights: [(String, String?, String?)] = [
                ("发送中 · 蓝色呼吸", nil, "Sending"),
                ("待确认 · 紫色常亮", nil, "送达状态未确认"),
                ("排队中 · 橙色常亮", "queued", nil),
                ("处理中 · 绿色呼吸", "processing", nil),
                ("失败 · 红色常亮", "failed", nil)]
            for (index, item) in lights.enumerated() {
                let id = "light:\(index)"
                var row: [String: Any] = ["id": id, "type": "userMessage", "text": item.0]
                if let state = item.1 { row["userMessageStatus"] = state }
                workspace.messages.append(decode(row))
                if let delivery = item.2 { workspace.outgoingStates[id] = delivery }
            }
        }
        // All fixture data is resident. Product history still reveals batches.
    }
}
#endif
