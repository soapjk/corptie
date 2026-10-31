import CorptieConversation
import Combine
import Foundation
import SwiftUI

extension Notification.Name {
    static let sessionMailboxRequested = Notification.Name("Corptie.sessionMailboxRequested")
}

struct SessionMailboxMessage: Decodable, Identifiable, Equatable {
    var id: String { messageId }
    let messageId: String
    let sourceType: String
    let sourceId: String
    let senderSessionId: String?
    let intent: String
    let preview: String
    let body: String?
    let state: String
    let executionStatus: String?
    let read: Bool
    let manualRequested: Bool
    let batchId: String?
    let batchCount: Int
    let turnId: String?
    let canHandle: Bool
    let createdAt: String
    let cursor: String
}

struct SessionMailboxPage: Decodable {
    let messages: [SessionMailboxMessage]
    let hasMore: Bool
    let beforeCursor: String?
    let pendingCount: Int
    let unreadCount: Int
    let paused: Bool
    let writesAllowed: Bool?
}

@MainActor
final class SessionMailboxModel: ObservableObject {
    @Published private(set) var messages: [SessionMailboxMessage] = []
    @Published private(set) var pendingCount = 0
    @Published private(set) var paused = false
    @Published private(set) var canWrite = false
    @Published private(set) var hasMore = false
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var expanded: [String: SessionMailboxMessage] = [:]
    private var cursor: String?
    private var generation = UUID()
    private var sessionID = ""
    private var filter = "pending"
    private var source = ""

    func load(sessionID: String, filter: String, source: String, older: Bool = false) async {
        if older && loading { return }
        let token = older ? generation : UUID()
        if !older { generation = token; expanded = [:] }
        self.sessionID = sessionID; self.filter = filter; self.source = source
        loading = true
        defer { if generation == token { loading = false } }
        do {
            var query = [URLQueryItem(name: "filter", value: filter), URLQueryItem(name: "limit", value: "30")]
            if !source.isEmpty { query.append(URLQueryItem(name: "sourceType", value: source)) }
            if older, let cursor { query.append(URLQueryItem(name: "beforeCursor", value: cursor)) }
            let page: SessionMailboxPage = try await request(sessionID: sessionID, query: query)
            guard !Task.isCancelled, generation == token else { return }
            let known = Set(messages.map(\.messageId))
            messages = older ? Array((messages + page.messages.filter { !known.contains($0.messageId) }).suffix(300)) : page.messages
            let retained = Set(messages.map(\.messageId))
            expanded = expanded.filter { retained.contains($0.key) }
            canWrite = page.writesAllowed ?? true
            pendingCount = page.pendingCount; paused = page.paused; hasMore = page.hasMore; cursor = page.beforeCursor
            error = nil
        } catch { if generation == token && !Task.isCancelled { self.error = error.localizedDescription } }
    }

    func toggle(_ message: SessionMailboxMessage) async {
        if expanded.removeValue(forKey: message.id) != nil { return }
        let token = generation
        do {
            let full: SessionMailboxMessage = try await request(sessionID: sessionID, suffix: "/messages/\(message.id)")
            guard generation == token else { return }
            expanded[message.id] = full
            if !message.read && canWrite {
                let read: SessionMailboxMessage = try await request(sessionID: sessionID, suffix: "/messages/\(message.id)/read", post: [:])
                guard generation == token else { return }
                if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = read }
            }
        } catch { if generation == token { self.error = error.localizedDescription } }
    }

    func perform(_ action: String, messageID: String) async {
        guard !loading, canWrite else { return }
        loading = true
        let token = generation
        do {
            let _: SessionMailboxMessage = try await request(sessionID: sessionID, suffix: "/messages/\(messageID)/\(action)", post: [:])
            guard generation == token else { return }
            loading = false
            await load(sessionID: sessionID, filter: filter, source: source)
        } catch { if generation == token { loading = false; self.error = error.localizedDescription } }
    }

    func setPaused(_ value: Bool) async {
        guard !loading, canWrite else { return }
        loading = true
        let token = generation
        do {
            struct Settings: Decodable { let paused: Bool }
            let result: Settings = try await request(sessionID: sessionID, suffix: "/settings", post: ["paused": value])
            guard generation == token else { return }
            paused = result.paused; loading = false; error = nil
        } catch { if generation == token { loading = false; self.error = error.localizedDescription } }
    }

    func retire() {
        generation = UUID()
        loading = false
        expanded = [:]
    }

    private func request<T: Decodable>(sessionID: String, suffix: String = "", query: [URLQueryItem] = [], post: [String: Bool]? = nil) async throws -> T {
        // Encode each path segment rather than treating message IDs as URLs.
        let path = ["sessions", sessionID, "mailbox"] + suffix.split(separator: "/").map(String.init)
        var url = CorptieAppEnvironment.backendBaseURL
        for segment in path { url.append(path: segment) }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!); request.timeoutInterval = 20
        if let post { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: post) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw BackendError.message((try? JSONDecoder().decode(BackendErrorResponse.self, from: data).error) ?? "信箱请求失败")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct SessionMailboxPanel: View {
    let sessionID: String
    let pendingRevision: String
    var activity: ConversationDetailPresentationActivity? = nil
    private var isActive: Bool { activity?.isActive ?? true }
    @StateObject private var model = SessionMailboxModel()
    @State private var filter = "pending"
    @State private var source = ""
    @State private var ignoreMessage: SessionMailboxMessage?
    private var loadKey: String { "\(sessionID):\(filter):\(source):\(pendingRevision):\(isActive)" }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("信箱", systemImage: "tray").font(.headline)
                Spacer()
                Text("待处理 \(model.pendingCount)").font(.caption).foregroundStyle(.secondary)
                Button { Task { await model.load(sessionID: sessionID, filter: filter, source: source) } }
                    label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).help("刷新信箱").accessibilityLabel("刷新信箱")
            }
            Toggle("暂停自动处理", isOn: Binding(get: { model.paused }, set: { value in Task { await model.setPaused(value) } }))
                .toggleStyle(.switch).disabled(model.loading || !model.canWrite)
            Picker("消息范围", selection: $filter) {
                Text("待处理").tag("pending"); Text("全部").tag("all"); Text("异常").tag("abnormal")
            }.pickerStyle(.segmented)
            Picker("来源", selection: $source) {
                Text("全部来源").tag(""); Text("会话协作").tag("channel"); Text("自动化").tag("automation")
                Text("后台作业").tag("background"); Text("系统").tag("system")
            }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            if model.loading && model.messages.isEmpty { ProgressView().frame(maxWidth: .infinity) }
            if model.messages.isEmpty && !model.loading { Text("暂无消息").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical) }
            ForEach(model.messages) { message in
                VStack(alignment: .leading, spacing: 8) {
                    Button { Task { await model.toggle(message) } } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Image(systemName: message.sourceType == "channel" ? "bubble.left.and.bubble.right" : "tray")
                                Text(sourceName(message.sourceType)).font(.caption.weight(.semibold))
                                Spacer(); if !message.read { Circle().fill(.blue).frame(width: 5, height: 5) }
                                Image(systemName: model.expanded[message.id] == nil ? "chevron.down" : "chevron.up").font(.caption2)
                            }
                            Text(message.preview).font(.callout).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Text(stateName(message)).font(.caption).foregroundStyle(.secondary)
                    if let full = model.expanded[message.id] {
                        Text(full.body ?? full.preview).font(.callout).textSelection(.enabled)
                        Text(full.senderSessionId ?? full.sourceId).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(full.createdAt).font(.caption2).foregroundStyle(.secondary)
                        if let turn = full.turnId { Text("Turn · \(turn)").font(.caption2.monospaced()).textSelection(.enabled) }
                    }
                    if message.canHandle && model.canWrite {
                        HStack {
                            Button("立即处理") { Task { await model.perform("process", messageID: message.id) } }
                            Spacer()
                            Button("忽略", role: .destructive) { ignoreMessage = message }
                        }.font(.caption).disabled(model.loading)
                    }
                }.padding(10).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }
            if model.hasMore { Button("加载更早消息") { Task { await model.load(sessionID: sessionID, filter: filter, source: source, older: true) } }.disabled(model.loading) }
        }
        .disabled(!isActive)
        .task(id: loadKey) {
            guard isActive else { return }
            await model.load(sessionID: sessionID, filter: filter, source: source)
        }
        .onChange(of: isActive) { _, active in if !active { model.retire() } }
        .onDisappear { model.retire() }
        .confirmationDialog("忽略这封尚未注入的消息？", isPresented: Binding(get: { ignoreMessage != nil }, set: { if !$0 { ignoreMessage = nil } })) {
            if let message = ignoreMessage { Button("忽略消息", role: .destructive) { ignoreMessage = nil; Task { await model.perform("ignore", messageID: message.id) } } }
            Button("取消", role: .cancel) { ignoreMessage = nil }
        }
    }

    private func sourceName(_ value: String) -> String {
        switch value { case "channel": "会话协作"; case "automation": "自动化"; case "background": "后台作业"; default: "系统" }
    }
    private func stateName(_ message: SessionMailboxMessage) -> String {
        let label: String = switch message.state {
        case "injected": "已注入"; case "adopted": "当前回合已领取"; case "ignored": "已忽略"
        case "unknown": "投递结果待确认 · 不自动重发"; case "failed": "投递失败"
        default: ["notification", "acknowledgement"].contains(message.intent) && !message.manualRequested ? "已保存 · 不单独唤醒" : "等待处理"
        }
        var parts = [label]
        if message.batchCount > 1 { parts.append("本批 \(message.batchCount) 条") }
        if let status = message.executionStatus {
            let execution = switch status {
            case "running": "执行中"; case "completed": "执行结束"; case "failed": "执行失败"
            case "cancelled": "执行已取消"; default: ""
            }
            if !execution.isEmpty { parts.append(execution) }
        }
        return parts.joined(separator: " · ")
    }
}
