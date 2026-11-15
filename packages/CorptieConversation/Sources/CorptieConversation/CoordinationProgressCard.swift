import SwiftUI
import CorptieClientCore

/// Shared bounded preview. Reading task/report detail never expands a timeline
/// row: a preview owns its pagination, network work and lazy content lifetime.
public struct CoordinationProgressCard: View {
    public let progress: ClientCoordinationProgress
    public let openSession: (String) -> Void
    public var api: (() async throws -> ClientDetailAPI)?
    @State private var selection: ClientCoordinationProgressItem?
    @State private var showingAll = false
    public init(progress: ClientCoordinationProgress, api: (() async throws -> ClientDetailAPI)? = nil,
                openSession: @escaping (String) -> Void) {
        self.progress = progress; self.api = api; self.openSession = openSession
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("子任务进展", bundle: .module).font(.headline)
                Spacer(minLength: 8)
                Text("已交付 \(progress.counts["delivered", default: 0] + progress.counts["accepted", default: 0])/\(progress.total)", bundle: .module)
                    .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    .accessibilityLabel(Text("已交付或验收 \(progress.counts["delivered", default: 0] + progress.counts["accepted", default: 0]) 项，共 \(progress.total) 项", bundle: .module))
            }
            ForEach(progress.items.prefix(3)) { item in
                Button { selection = item } label: { CoordinationProgressRow(item: item) }
                    #if os(macOS)
                    .popover(isPresented: Binding(get: { selection?.id == item.id }, set: { if !$0 { selection = nil } })) {
                        CoordinationProgressItemDetail(item: item, progress: progress, api: api, openSession: openSession)
                            .frame(width: 460)
                    }
                    #endif
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("查看任务详情", bundle: .module))
            }
            if progress.total > 0, progress.counts["delivered", default: 0] + progress.counts["accepted", default: 0] == progress.total {
                Text("本批已交付，整体验收以集成结果为准。", bundle: .module)
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !progress.focus.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Text("当前重点：\(progress.focus)", bundle: .module).font(.caption).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
            if !progress.decision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Label { Text("需要你决定：\(progress.decision)", bundle: .module) } icon: { Image(systemName: "questionmark.circle") }.font(.caption).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
            if progress.hasMore || progress.total > 3 { Button { showingAll = true } label: { Text("查看全部 \(progress.total) 项", bundle: .module) }.font(.caption) }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .modifier(ConversationSkinSurface(role: .structured, radius: 12, legacyFill: WorkbenchCanvasSurface.defaultColor, legacyBorder: Color.primary.opacity(0.10)))
        #if os(iOS)
        .sheet(item: $selection) { item in
            CoordinationProgressItemDetail(item: item, progress: progress, api: api, openSession: openSession)
                .presentationDragIndicator(.visible)
        }
        #endif
        .sheet(isPresented: $showingAll) {
            CoordinationProgressList(progress: progress, api: api, openSession: openSession)
                .frame(minWidth: 280, minHeight: 360)
        }
    }
}
private struct CoordinationProgressRow: View {
    let item: ClientCoordinationProgressItem
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var description: String { item.previewSummary }
    private var status: some View {
        Label { Text(LocalizedStringKey(item.statusTitle), bundle: .module) } icon: { Image(systemName: item.statusSymbol) }
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: true, vertical: false)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if dynamicTypeSize.isAccessibilitySize {
                Text(item.title).font(.subheadline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                status
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title).font(.subheadline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    status
                }
            }
            if !description.isEmpty {
                Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        #if os(iOS)
        .frame(minHeight: 44, alignment: .leading)
        #endif
        .contentShape(Rectangle())
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
    @State private var contentHeight: CGFloat = 180
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    Text(item.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Label { Text(LocalizedStringKey(item.statusTitle), bundle: .module) } icon: { Image(systemName: item.statusSymbol) }
                        .font(.caption).foregroundStyle(.secondary).fixedSize()
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).accessibilityLabel(Text("关闭", bundle: .module))
                }
                if !item.previewSummary.isEmpty { Text(item.previewSummary).font(.callout).textSelection(.enabled) }
                if !item.reason.isEmpty, item.reason != item.previewSummary {
                    Text(item.reason).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if !report.isEmpty { Text(report).font(.callout).textSelection(.enabled) }
                if loading { ProgressView().controlSize(.small) }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    if let session = item.sessionId { Button { dismiss(); openSession(session) } label: { Text("打开子会话", bundle: .module) } }
                    Spacer(minLength: 0)
                    if item.reportMessageId != nil, nextOffset != nil, !loading {
                        Button { request = Task { await loadReport() } } label: {
                            Text(report.isEmpty ? "重试读取报告" : "继续读取报告", bundle: .module)
                        }
                    }
                }.font(.caption).buttonStyle(.borderless)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: CoordinationPreviewHeight.self, value: geometry.size.height)
            })
        }
        .onPreferenceChange(CoordinationPreviewHeight.self) { height in
            if abs(contentHeight - height) > 1 { contentHeight = height }
        }
        #if os(macOS)
        .frame(height: min(480, max(100, contentHeight)))
        #else
        .presentationDetents([.height(min(560, max(160, contentHeight + 24))), .large])
        #endif
        .task(id: item.id) { if item.reportMessageId != nil, report.isEmpty { await loadReport() } }
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

private struct CoordinationPreviewHeight: PreferenceKey {
    static let defaultValue: CGFloat = 180
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Shadow reports and delivery receipts are events, not another parent reply.
public struct CoordinationSummaryCard: View {
    public let event: ConversationCoordinationEvent
    public let text: String
    public init(event: ConversationCoordinationEvent, text: String) { self.event = event; self.text = text }
    private var bodyText: String {
        // Legacy reports carry this generated heading; classification uses metadata only.
        event.kind == "summary" && text.hasPrefix("**后台汇总**\n\n")
            ? String(text.dropFirst("**后台汇总**\n\n".count)) : text
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label { Text(event.kind == "summary" ? "任务汇总" : "交付通知", bundle: .module) }
                icon: { Image(systemName: event.kind == "summary" ? "text.alignleft" : "checkmark.circle") }
                .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            Text(bodyText).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .modifier(ConversationSkinSurface(role: .structured, radius: 12,
                legacyFill: WorkbenchCanvasSurface.defaultColor, legacyBorder: Color.primary.opacity(0.10)))
    }
}
