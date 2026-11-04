import SwiftUI
import CorptieClientCore

/// Shared bounded preview. Reading task/report detail never expands a timeline
/// row: a sheet owns its pagination, network work and lazy content lifetime.
public struct CoordinationProgressCard: View {
    public let progress: ClientCoordinationProgress
    public let openSession: (String) -> Void
    public var api: (() async throws -> ClientDetailAPI)?
    @State private var selection: ClientCoordinationProgressItem?
    @State private var showingAll = false
    @ScaledMetric private var scale = 1.0
    public init(progress: ClientCoordinationProgress, api: (() async throws -> ClientDetailAPI)? = nil,
                openSession: @escaping (String) -> Void) {
        self.progress = progress; self.api = api; self.openSession = openSession
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("子任务进展").font(.headline)
                Spacer(minLength: 8)
                Text("\(progress.counts["delivered", default: 0] + progress.counts["accepted", default: 0])/\(progress.total)")
                    .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    .accessibilityLabel(Text("已交付或验收 \(progress.counts["delivered", default: 0] + progress.counts["accepted", default: 0]) 项，共 \(progress.total) 项"))
            }
            ForEach(progress.items.prefix(3)) { item in
                Button { selection = item } label: { CoordinationProgressRow(item: item) }
                    .buttonStyle(.plain).frame(height: 58 * scale, alignment: .top)
                    .accessibilityHint(Text("查看任务详情"))
            }
            if !progress.focus.isEmpty { Text(progress.focus).font(.caption).foregroundStyle(.secondary).lineLimit(2).frame(height: 32 * scale, alignment: .topLeading) }
            if !progress.decision.isEmpty { Label(progress.decision, systemImage: "questionmark.circle").font(.caption).lineLimit(2).frame(height: 32 * scale, alignment: .topLeading) }
            if progress.hasMore { Button("查看全部 \(progress.total) 项") { showingAll = true }.font(.caption) }
            Spacer(minLength: 0)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: progress.previewHeight * scale, alignment: .top)
        .modifier(ConversationSkinSurface(role: .structured, radius: 12, legacyFill: Color.secondary.opacity(0.05)))
        .sheet(item: $selection) { item in
            NavigationStack { CoordinationProgressItemDetail(item: item, progress: progress, api: api, openSession: openSession) }
                .frame(minWidth: 280, minHeight: 280)
        }
        .sheet(isPresented: $showingAll) {
            CoordinationProgressList(progress: progress, api: api, openSession: openSession)
                .frame(minWidth: 280, minHeight: 360)
        }
    }
}
private struct CoordinationProgressRow: View {
    let item: ClientCoordinationProgressItem
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.title).font(.subheadline).lineLimit(2)
                Spacer(minLength: 8)
                Label(title, systemImage: symbol).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: true, vertical: false)
            }
            if !item.summary.isEmpty { Text(item.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    private var title: LocalizedStringKey {
        switch item.state {
        case "preparing": "准备中"
        case "queued": "排队中"
        case "running": "执行中"
        case "waiting_input": "等待输入"
        case "blocked": "阻塞"
        case "delivered": "已交付"
        case "accepted": "已验收"
        case "cancelled": "已取消"
        default: "待核实"
        }
    }
    private var symbol: String {
        switch item.state {
        case "running": "play.circle"
        case "blocked", "waiting_input": "exclamationmark.circle"
        case "delivered", "accepted": "checkmark.circle"
        case "cancelled": "xmark.circle"
        default: "clock"
        }
    }
}
private struct CoordinationProgressList: View {
    let progress: ClientCoordinationProgress
    let api: (() async throws -> ClientDetailAPI)?
    let openSession: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var items: [ClientCoordinationProgressItem] = []
    @State private var nextOffset: Int? = 0
    @State private var request: Task<Void, Never>?
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                ForEach(items) { item in
                    NavigationLink { CoordinationProgressItemDetail(item: item, progress: progress, api: api, openSession: openSession) }
                        label: { CoordinationProgressRow(item: item) }
                }
                if let error { Text(error).foregroundStyle(.red) }
                if nextOffset != nil { Button(loading ? "正在加载…" : "加载更多") { request = Task { await load() } }.disabled(loading) }
            }
            .navigationTitle("子任务进展")
            .toolbar { Button("关闭") { dismiss() } }
            .task { if items.isEmpty { await load() } }
            .onDisappear { request?.cancel(); request = nil }
        }
    }
    private func load() async {
        guard !loading, let offset = nextOffset, let api else { return }
        loading = true; defer { loading = false }
        do {
            let client = try await api()
            let page = try await client.coordinationProgressPage(sessionID: progress.parentSessionId, batchID: progress.batchId, offset: offset)
            try Task.checkCancellation(); items.append(contentsOf: page.items); nextOffset = page.nextOffset; error = nil
        } catch is CancellationError { } catch { if !Task.isCancelled { self.error = "加载失败，请重试" } }
    }
}
private struct CoordinationProgressItemDetail: View {
    let item: ClientCoordinationProgressItem
    let progress: ClientCoordinationProgress
    let api: (() async throws -> ClientDetailAPI)?
    let openSession: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var report = ""
    @State private var nextOffset: Int? = 0
    @State private var request: Task<Void, Never>?
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                CoordinationProgressRow(item: item)
                if !item.reason.isEmpty { Text(item.reason).font(.callout).textSelection(.enabled) }
                if let session = item.sessionId { Button("打开子会话") { openSession(session) } }
                if item.reportMessageId != nil, nextOffset != nil {
                    Button(loading ? "正在加载…" : report.isEmpty ? "查看报告" : "继续读取报告") { request = Task { await loadReport() } }.disabled(loading)
                }
                if let error { Text(error).foregroundStyle(.red) }
                if !report.isEmpty { Text(report).font(.callout).textSelection(.enabled) }
            }.padding().frame(maxWidth: .infinity, alignment: .leading)
        }.navigationTitle(item.title).toolbar { Button("关闭") { dismiss() } }
        .onDisappear { request?.cancel(); request = nil }
    }
    private func loadReport() async {
        guard !loading, let offset = nextOffset, let api else { return }
        loading = true; defer { loading = false }
        do {
            let client = try await api()
            let page = try await client.coordinationProgressReport(sessionID: progress.parentSessionId, batchID: progress.batchId, assignmentID: item.id, offset: offset)
            try Task.checkCancellation(); report += page.text; nextOffset = page.nextOffset; error = nil
        } catch is CancellationError { } catch { if !Task.isCancelled { self.error = "读取报告失败，请重试" } }
    }
}
