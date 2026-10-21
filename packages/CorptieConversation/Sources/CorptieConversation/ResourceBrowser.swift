import SwiftUI
import Observation
import CorptieClientCore
import UniformTypeIdentifiers
import CryptoKit

@MainActor @Observable
final class ResourceBrowserStore {
    var items: [ClientResourceSummary] = []
    var cursor: String?
    var loading = false
    var error: String?
    var invalidItems = 0
    var canCreate = false
    private var generation = UUID()
    func load(api: ClientResourceAPI, query: String, work: String, status: String, sort: String, more: Bool = false) async {
        if more && (loading || cursor == nil || items.count >= 1000) { return }
        let token = more ? generation : UUID()
        if !more { generation = token }
        loading = true; error = nil
        defer { if generation == token { loading = false } }
        do {
            let page = try await api.list(query: query, workId: work.isEmpty ? nil : work, status: status, sort: sort, cursor: more ? cursor : nil)
            try Task.checkCancellation()
            guard generation == token else { return }
            if more {
                var ids = Set(items.map(\.id))
                items += page.items.filter { ids.insert($0.id).inserted }
                invalidItems += page.invalidItemCount
            } else { items = page.items; invalidItems = page.invalidItemCount }
            cursor = page.nextCursor
            canCreate = page.capabilities.contains("create")
        } catch is CancellationError { }
        catch {
            if generation == token {
                if let failure = error as? ClientServiceFailure, [401, 403].contains(failure.statusCode) { items = []; cursor = nil; canCreate = false }
                self.error = Self.message(error)
            }
        }
    }
    func reset() { generation = UUID(); items = []; cursor = nil; loading = false; error = nil; invalidItems = 0; canCreate = false }
    static func message(_ error: Error) -> String {
        if let failure = error as? ClientServiceFailure {
            if failure.statusCode == 409 { return "资源已变化，请刷新后重试" }
            if failure.statusCode == 413 { return "内容超过此操作的大小上限" }
            if failure.statusCode == 429 { return "请求或预览达到上限，请稍后重试或导出全文" }
            if [401, 403].contains(failure.statusCode) { return "连接或访问权限已失效，请重新连接" }
            if failure.statusCode == 404 { return "资源不存在、已撤销，或主机尚未支持资源管理" }
        }
        return "资源加载未完成，请检查连接后重试"
    }
}

public extension Notification.Name {
    static let corptieResourceCatalogChanged = Notification.Name("corptie.resource-catalog.changed")
    static let corptieOpenResource = Notification.Name("corptie.resource.open")
}

/// Shared catalog/reader. Platform shells own routing and credentials, not data semantics.
public struct ResourceBrowser: View {
    @Binding private var focus: ClientResourceFocus?
    let active: Bool
    let connected: Bool
    let works: [(id: String, name: String)]
    let currentWorkId: String?
    let api: @MainActor () async throws -> ClientResourceAPI
    let openSession: (String) -> Void
    @State private var store = ResourceBrowserStore()
    @State private var query = ""
    @State private var work = ""
    @State private var status = "all"
    @State private var sort = "updated"
    @State private var refreshID = 0
    @State private var listWidth: CGFloat = 300
    @State private var dragStart: CGFloat?
    @State private var showCreate = false
    @State private var catalogWorks: [ClientResourceAPI.Work] = []
    @State private var worksCursor: String?
    @State private var worksLoading = false
    @State private var worksError: String?
    private var availableWorks: [(id: String, name: String)] {
        var ids = Set<String>()
        return (catalogWorks.map { ($0.id, $0.name) } + works).filter { ids.insert($0.id).inserted }
    }
    public init(focus: Binding<ClientResourceFocus?>, active: Bool, connected: Bool = true,
                works: [(id: String, name: String)], currentWorkId: String? = nil,
                api: @escaping @MainActor () async throws -> ClientResourceAPI, openSession: @escaping (String) -> Void) {
        _focus = focus; self.active = active; self.connected = connected; self.works = works
        self.currentWorkId = currentWorkId; self.api = api; self.openSession = openSession
        _work = State(initialValue: focus.wrappedValue?.workId ?? "")
    }
    private var requestKey: String { "\(active):\(connected):\(query):\(work):\(status):\(sort):\(refreshID)" }
    public var body: some View {
        GeometryReader { geometry in
            if geometry.size.width >= 700 {
                HStack(spacing: 0) {
                    catalog.frame(width: listWidth)
                    Rectangle().fill(Color.secondary.opacity(0.2)).frame(width: 1)
                        .overlay { Color.clear.frame(width: 10).contentShape(Rectangle()).gesture(DragGesture().onChanged { value in
                            if dragStart == nil { dragStart = listWidth }
                            listWidth = min(480, max(240, (dragStart ?? 300) + value.translation.width))
                        }.onEnded { _ in dragStart = nil }) }
                    selected.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                NavigationStack {
                    catalog.navigationDestination(isPresented: Binding(get: { !(focus?.id.isEmpty ?? true) }, set: { if !$0 { focus = nil } })) {
                        selected.navigationTitle("资源详情").navigationBarTitleDisplayModeCompat()
                    }
                }
            }
        }
        .task(id: requestKey) {
            guard active, connected else { return }
            do { try await Task.sleep(for: .milliseconds(250)); try Task.checkCancellation(); await load() }
            catch { }
        }
        .task(id: active && connected) { if active && connected && catalogWorks.isEmpty { await loadWorks() } }
        .onChange(of: connected) { _, value in if !value { store.reset(); focus = nil; catalogWorks = []; worksCursor = nil } }
        .onChange(of: focus) { _, value in if let workId = value?.workId { work = workId; query = ""; status = "all" } }
        .onReceive(NotificationCenter.default.publisher(for: .corptieResourceCatalogChanged)) { _ in if active { refreshID &+= 1 } }
        .sheet(isPresented: $showCreate) {
            ResourceCreateForm(works: availableWorks, initialWork: work, api: api) { resource in
                focus = .init(id: resource.id); refreshID &+= 1
            }
        }
    }
    private var catalog: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("资源管理").font(.headline); Spacer()
                if store.canCreate { Button { showCreate = true } label: { Image(systemName: "plus") }.help("创建 Artifact").accessibilityLabel("创建 Artifact") }
                Button { refreshID &+= 1 } label: { Image(systemName: "arrow.clockwise") }.help("刷新资源").accessibilityLabel("刷新资源")
            }
            TextField("搜索标题、摘要、标签", text: $query).textFieldStyle(.roundedBorder)
            Picker("Work", selection: $work) {
                Text("全部 Work").tag("")
                if let currentWorkId { Text("当前 Work").tag(currentWorkId) }
                ForEach(availableWorks.filter { $0.id != currentWorkId }, id: \.id) { value in Text(value.name).tag(value.id) }
            }
            if worksCursor != nil {
                if catalogWorks.count >= 1000 { Text("Work 较多，可从工作台选中当前 Work 后筛选").font(.caption).foregroundStyle(.secondary) }
                else { Button("加载更多 Work") { Task { await loadWorks(more: true) } }.font(.caption).disabled(worksLoading) }
            }
            if let worksError { Text(worksError).font(.caption).foregroundStyle(.secondary); Button("重试 Work 列表") { Task { await loadWorks() } } }
            HStack {
                Picker("状态", selection: $status) { Text("全部状态").tag("all"); Text("草稿").tag("draft"); Text("已批准").tag("approved") }
                Picker("排序", selection: $sort) { Text("最近更新").tag("updated"); Text("最近创建").tag("created") }
            }.font(.caption)
            if !connected { Text("请连接主机以查看资源").foregroundStyle(.secondary) }
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.red); Button("重试") { refreshID &+= 1 } }
            if store.invalidItems > 0 { Text("\(store.invalidItems) 条资源数据异常，其他资源仍可查看").font(.caption).foregroundStyle(.orange) }
            if store.loading { ProgressView().controlSize(.small) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    if store.items.isEmpty && !store.loading && store.error == nil && connected {
                        Text(query.isEmpty && work.isEmpty && status == "all" ? "尚无资源" : "没有匹配的资源").foregroundStyle(.secondary).padding(.vertical)
                        if !query.isEmpty || !work.isEmpty || status != "all" { Button("清除筛选") { query = ""; work = ""; status = "all" } }
                    }
                    ForEach(store.items) { item in
                        Button { focus = .init(id: item.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                if !item.summary.isEmpty { Text(item.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                HStack { Text(item.workName.isEmpty ? "会话资源" : item.workName); Spacer(); Text(item.previewState == "draft" ? "草稿" : "v\(item.currentVersion)") }.font(.caption2).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                                .background(focus?.id == item.id ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).id(item.id)
                    }
                    if store.cursor != nil {
                        if store.items.count >= 1000 { Text("已加载 1000 项，请缩小筛选范围").font(.caption) }
                        else { Button("加载更多") { Task { await load(more: true) } }.disabled(store.loading) }
                    }
                }
            }
        }.padding(12)
    }
    @ViewBuilder private var selected: some View {
        if let focus, !focus.id.isEmpty, connected {
            ResourceDetail(focus: focus, active: active, api: api, openSession: openSession,
                           changed: { refreshID &+= 1 }, removed: { self.focus = nil; refreshID &+= 1 }).id(focus)
        } else { Text("选择资源查看内容").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
    private func load(more: Bool = false) async {
        do { await store.load(api: try await api(), query: query, work: work, status: status, sort: sort, more: more) }
        catch { store.error = ResourceBrowserStore.message(error) }
    }
    private func loadWorks(more: Bool = false) async {
        guard !worksLoading, !more || catalogWorks.count < 1000 else { return }; worksLoading = true; defer { worksLoading = false }
        do {
            let page = try await api().works(cursor: more ? worksCursor : nil); try Task.checkCancellation()
            guard connected else { return }
            if more { var ids = Set(catalogWorks.map(\.id)); catalogWorks += page.items.filter { ids.insert($0.id).inserted } }
            else { catalogWorks = page.items }
            worksCursor = page.nextCursor; worksError = nil
        } catch is CancellationError { } catch { worksError = "Work 列表未完整载入，可重试" }
    }
}

private extension View {
    @ViewBuilder func navigationBarTitleDisplayModeCompat() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}

private struct ResourceDetail: View {
    private enum Editor: String, Identifiable { case metadata, publish; var id: String { rawValue } }
    let focus: ClientResourceFocus
    let active: Bool
    let api: @MainActor () async throws -> ClientResourceAPI
    let openSession: (String) -> Void
    let changed: () -> Void
    let removed: () -> Void
    @State private var detail: ClientResourceDetail?
    @State private var version = 0
    @State private var loadedVersion = 0
    @State private var chunks: [ResourceDocumentChunk] = []
    @State private var loadedPages = 0
    @State private var readTask: Task<Void, Never>?
    @State private var offset: Int? = 0
    @State private var readID = UUID().uuidString
    @State private var error: String?
    @State private var loading = false
    @State private var binary = false
    @State private var busy = false
    @State private var deleteConfirm = false
    @State private var editor: Editor?
    @State private var editedTitle = ""
    @State private var editedSummary = ""
    @State private var editedContent = ""
    @State private var targetSession = ""
    @State private var removingReference: String?
    @State private var exportPresented = false
    @State private var exportBytes = Data()
    @State private var exportType = UTType.data
    @State private var exportName = "Artifact"
    @State private var metadataRefresh = 0
    @State private var editingResource: ClientResourceSummary?
    @State private var approvePublication = false
    private var selectedVersion: ClientResourceDetail.Version? { detail?.versions.first { $0.version == version } }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if let detail {
                    Text(detail.resource.title).font(.title2).textSelection(.enabled)
                    Text(detail.resource.workName.isEmpty ? "会话资源" : detail.resource.workName).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Picker("版本", selection: $version) { ForEach(detail.versions) { value in Text("v\(value.version)\(value.approvalStatus == "draft" ? " · 草稿" : "")").tag(value.version) } }.frame(maxWidth: 260)
                        Spacer()
                        Menu {
                            Button(offset == nil ? "复制正文" : "复制已载入正文") { copyResourceText(chunks.map(\.text).joined()) }.disabled(binary || chunks.isEmpty)
                            if detail.resource.capabilities.contains("metadata") { Button("编辑信息") { editingResource = detail.resource; editedTitle = detail.resource.title; editedSummary = detail.resource.summary; editor = .metadata } }
                            if detail.resource.capabilities.contains("publish") {
                                Button("编辑并发布新版本") { editingResource = detail.resource; approvePublication = false; editedContent = chunks.map(\.text).joined(); editor = .publish }
                                    .disabled(offset != nil || binary || chunks.isEmpty || version != detail.resource.currentVersion)
                            }
                            if detail.resource.capabilities.contains("export") {
                                Button("导出此版本…") { Task { await exportVersion() } }.disabled((selectedVersion?.byteLength ?? 0) > 16 * 1024 * 1024)
                                if (selectedVersion?.byteLength ?? 0) > 16 * 1024 * 1024 { Text("直接导出上限 16 MiB") }
                            }
                            if detail.resource.capabilities.contains("revoke") { Button("删除资源…", role: .destructive) { deleteConfirm = true } }
                        } label: { Image(systemName: "ellipsis") }.disabled(busy)
                    }
                    if focus.version == version { Text("正在查看会话引用的固定版本，不会自动跟随更新").font(.caption).foregroundStyle(.secondary) }
                    else if focus.version != nil { Text("正在预览其他版本，原会话引用未改变").font(.caption).foregroundStyle(.secondary) }
                    if version > 0 && detail.resource.currentVersion > version { Text("有更新版本，可从版本菜单选择；当前阅读内容保持不变").font(.caption).foregroundStyle(.secondary) }
                    if binary { Text("此版本无法直接预览，请从右上角菜单导出原文件。").foregroundStyle(.secondary) }
                    if selectedVersion?.mimeType == "application/vnd.corptie.repository-reference" { Text("此资源引用仓库中的文件，不存储独立正文。").foregroundStyle(.secondary) }
                    ForEach(chunks) { chunk in ResourceDocumentView(chunk: chunk) }
                    if let error { Text(error).font(.caption).foregroundStyle(.red); Button("重试") { beginRead() } }
                    if offset != nil && !binary && error == nil {
                        if loadedPages >= 32 { Text("已达到预览上限，请从右上角菜单导出全文").font(.caption) }
                        else { Button(loading ? "读取中…" : "继续读取") { beginRead() }.disabled(loading) }
                    }
                    DisclosureGroup("来源与关联") {
                        VStack(alignment: .leading, spacing: 10) {
                            if let id = detail.resource.sourceSessionId { Button("打开来源会话：\(detail.resource.sourceTitle)") { openSession(id) } }
                            if detail.references.isEmpty { Text("没有显式引用；来源记录不代表已加入模型上下文").font(.caption).foregroundStyle(.secondary) }
                            if detail.resource.capabilities.contains("reference"), !detail.targets.isEmpty {
                                Picker("关联到会话（最近 100 个）", selection: $targetSession) {
                                    Text("选择会话").tag("")
                                    ForEach(detail.targets) { Text($0.title).tag($0.id) }
                                }
                                Button("关联当前版本") {
                                    guard let target = detail.targets.first(where: { $0.id == targetSession }) else { return }
                                    Task { await command("reference", fields: [target.taskId == nil ? "sessionId" : "taskId": .string(target.taskId ?? target.id), "version": .number(Double(version))]) }
                                }.disabled(busy || targetSession.isEmpty)
                            }
                            ForEach(detail.references) { ref in
                                HStack {
                                    Text("v\(ref.version) · \(ref.policy)").font(.caption)
                                    if let id = ref.sessionId { Button("打开会话") { openSession(id) } }
                                    if detail.resource.capabilities.contains("reference") {
                                        Button("移除引用", role: .destructive) { removingReference = ref.id }.disabled(busy)
                                    }
                                }
                            }
                            if detail.referencesTruncated { Text("仅展示最近 100 条引用").font(.caption).foregroundStyle(.secondary) }
                            if detail.versionsTruncated { Text("版本选择展示最近 100 版；会话固定引用仍可打开对应历史版本").font(.caption).foregroundStyle(.secondary) }
                        }.padding(.top, 8)
                    }
                } else if let error { Text(error).foregroundStyle(.red); Button("重试") { Task { await loadDetail() } } }
                else { ProgressView() }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: "\(active):\(metadataRefresh)") {
            guard active else { return }
            do { try await Task.sleep(for: .milliseconds(80)); try Task.checkCancellation(); await loadDetail(preserveVersion: detail != nil) } catch { }
        }
        .onReceive(NotificationCenter.default.publisher(for: .corptieResourceCatalogChanged)) { _ in if active { metadataRefresh &+= 1 } }
        .task(id: "\(version):\(active)") {
            readTask?.cancel(); readTask = nil
            guard active, version > 0 else { return }
            if loadedVersion == version && !chunks.isEmpty { return }
            chunks = []; loadedPages = 0; offset = 0; error = nil; binary = false; readID = UUID().uuidString
            loading = false; loadedVersion = version
            await loadNext()
        }
        .onDisappear { readTask?.cancel(); readTask = nil }
        .confirmationDialog("删除资源将影响现有引用，移除会话引用不会删除资源。是否继续？", isPresented: $deleteConfirm, titleVisibility: .visible) {
            Button("删除资源", role: .destructive) { Task { await command("revoke", fields: ["confirmed": .bool(true)]) } }
        }
        .confirmationDialog("只移除此会话引用，不删除资源原文？", isPresented: Binding(get: { removingReference != nil }, set: { if !$0 { removingReference = nil } }), titleVisibility: .visible) {
            Button("移除引用", role: .destructive) {
                if let id = removingReference { Task { await command("unreference", fields: ["referenceId": .string(id), "confirmed": .bool(true)]) } }
                removingReference = nil
            }
        }
        .fileExporter(isPresented: $exportPresented, document: ResourceExportDocument(data: exportBytes), contentType: exportType, defaultFilename: exportName) { result in
            exportBytes = Data()
            if case .failure = result { error = "文件导出未完成，请重试" }
        }
        .sheet(item: $editor, onDismiss: { editingResource = nil }) { mode in
            VStack(alignment: .leading, spacing: 14) {
                Text(mode == .metadata ? "编辑资源信息" : "发布新版本").font(.headline)
                if mode == .metadata {
                    TextField("标题", text: $editedTitle)
                    TextField("摘要", text: $editedSummary, axis: .vertical).lineLimit(3...6)
                } else {
                    Text("不会改变已有固定版本引用").font(.caption).foregroundStyle(.secondary)
                    Toggle("批准新版本（默认保存为草稿）", isOn: $approvePublication)
                    TextEditor(text: $editedContent).font(.system(.body, design: .monospaced)).frame(minHeight: 260)
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack { Button("取消") { editor = nil }; Spacer(); Button("保存") {
                    Task {
                        await command(mode == .metadata ? "metadata" : "publish", fields: mode == .metadata ? ["title": .string(editedTitle), "summary": .string(editedSummary)] : ["content": .string(editedContent), "approved": .bool(approvePublication)])
                        if error == nil { editor = nil }
                    }
                }.disabled(busy || (mode == .metadata && editedTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (mode == .publish && editedContent.utf8.count > 128 * 1024)) }
            }.padding(24).frame(minWidth: 280, idealWidth: 460)
        }
    }
    private func loadDetail(preserveVersion: Bool = false) async {
        do {
            let value = try await api().detail(focus.id, version: preserveVersion && version > 0 ? version : focus.version); try Task.checkCancellation()
            guard value.schemaVersion == 1, value.resource.id == focus.id else { throw ClientConnectionError.invalidResponse }
            let selected = preserveVersion && version > 0 ? version : focus.version ?? value.resource.currentVersion
            guard let candidate = value.versions.first(where: { $0.version == selected }), selected != focus.version || focus.hash == nil || candidate.contentHash == focus.hash else { throw ClientConnectionError.invalidResponse }
            detail = value; error = nil
            version = selected
        } catch is CancellationError { } catch { fail(error) }
    }
    private func beginRead() {
        guard active, !loading, readTask == nil else { return }
        readTask = Task { await loadNext(); if !Task.isCancelled { readTask = nil } }
    }
    private func loadNext() async {
        guard active, !loading, let requested = offset, let selectedVersion, loadedPages < 32 else { return }
        let expectedVersion = version, expectedRead = readID
        loading = true
        defer { if readID == expectedRead { loading = false } }
        do {
            let page = try await api().read(focus.id, version: expectedVersion, hash: selectedVersion.contentHash, offset: requested, readId: expectedRead)
            try Task.checkCancellation()
            guard active, version == expectedVersion, readID == expectedRead else { return }
            guard page.artifactId == focus.id, page.version == expectedVersion, page.contentHash == selectedVersion.contentHash,
                  page.range.offset == requested, page.range.nextOffset == nil || page.range.nextOffset! > requested else { throw ClientConnectionError.invalidResponse }
            let isBinary = page.encoding == "base64"
            if !isBinary, let content = page.content {
                let source = (chunks.first?.text ?? "") + content
                guard source.utf8.count <= 2 * 1024 * 1024 else { throw ClientConnectionError.invalidResponse }
                let prepared = try await ResourceDocumentChunk.prepare(id: 0, text: source,
                    mimeType: page.mimeType, title: detail?.resource.title ?? "", previous: chunks.first)
                try Task.checkCancellation()
                guard active, version == expectedVersion, readID == expectedRead else { return }
                chunks = [prepared]
            }
            binary = isBinary; loadedPages += 1
            offset = page.range.nextOffset; error = nil
        } catch is CancellationError { }
        catch { if active, version == expectedVersion, readID == expectedRead { fail(error) } }
    }
    private func command(_ action: String, fields: [String: ClientInspectorValue]) async {
        guard !busy, let detail else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let resource = ["metadata", "publish"].contains(action) ? editingResource ?? detail.resource : detail.resource
            try await api().command(resource, action: action, fields: fields); try Task.checkCancellation()
            changed(); NotificationCenter.default.post(name: .corptieResourceCatalogChanged, object: nil)
            if action == "revoke" { removed() } else { await loadDetail() }
        } catch is CancellationError { } catch { fail(error) }
    }
    private func exportVersion() async {
        guard !busy, let resource = detail?.resource, let selectedVersion else { return }
        busy = true; defer { busy = false }
        do {
            let exported = try await api().export(resource, version: selectedVersion.version, hash: selectedVersion.contentHash)
            try Task.checkCancellation()
            guard let bytes = Data(base64Encoded: exported.dataBase64), bytes.count == selectedVersion.byteLength,
                  SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == selectedVersion.contentHash else { throw ClientConnectionError.invalidResponse }
            exportBytes = bytes; exportType = UTType(mimeType: exported.mimeType) ?? .data; exportName = exported.fileName
            exportPresented = true
        } catch is CancellationError { } catch { fail(error) }
    }
    private func fail(_ error: Error) {
        if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
            detail = nil; chunks = []; offset = nil; version = 0; loadedVersion = 0; readID = UUID().uuidString; exportBytes = Data()
        }
        self.error = ResourceBrowserStore.message(error)
    }
}

private struct ResourceExportDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.data]
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct ResourceCreateForm: View {
    let works: [(id: String, name: String)]
    let initialWork: String
    let api: @MainActor () async throws -> ClientResourceAPI
    let saved: (ClientResourceSummary) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var work = ""
    @State private var title = ""
    @State private var summary = ""
    @State private var content = ""
    @State private var requestID = UUID().uuidString
    @State private var busy = false
    @State private var error: String?
    @State private var fileImporter = false
    @State private var importedBytes: Data?
    @State private var importedName = ""
    @State private var importedType = "text/markdown"
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("创建 Artifact").font(.headline)
            Picker("所属 Work", selection: $work) { ForEach(works, id: \.id) { Text($0.name).tag($0.id) } }
            TextField("标题", text: $title)
            TextField("摘要", text: $summary)
            if let importedBytes {
                Text("\(importedName) · \(importedBytes.count) bytes").textSelection(.enabled)
                Button("改为手动输入") { self.importedBytes = nil; importedType = "text/markdown" }
            } else { TextEditor(text: $content).font(.system(.body, design: .monospaced)).frame(minHeight: 240) }
            Button("从文件导入…") { fileImporter = true }.disabled(busy)
            Text("保存为草稿，上限 128 KiB。导入会复制内容，原文件不变；普通文件引用不需要导入。").font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack { Button("取消") { dismiss() }; Spacer(); Button(busy ? "保存中…" : "保存") { Task { await save() } }
                    .disabled(busy || work.isEmpty || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.utf8.count > 128 * 1024) }
        }.padding(24).frame(minWidth: 280, idealWidth: 520)
        .fileImporter(isPresented: $fileImporter, allowedContentTypes: [.data]) { result in
            if case .success(let url) = result { Task { await importFile(url) } }
            else if case .failure = result { error = "文件选择未完成" }
        }
        .onAppear { work = works.contains(where: { $0.id == initialWork }) ? initialWork : works.first?.id ?? "" }
    }
    private func save() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let value = try await api().create(workId: work, title: title, summary: summary, content: content, requestId: requestID, importedBytes: importedBytes, mimeType: importedType)
            try Task.checkCancellation(); saved(value.resource); dismiss()
            NotificationCenter.default.post(name: .corptieResourceCatalogChanged, object: nil)
        } catch is CancellationError { } catch { self.error = ResourceBrowserStore.message(error) }
    }
    private func importFile(_ url: URL) async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let bytes = try await Task.detached(priority: .userInitiated) {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw ClientConnectionError.invalidResponse }
                let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
                var data = Data()
                while let chunk = try handle.read(upToCount: 16384), !chunk.isEmpty {
                    data.append(chunk)
                    if data.count > 131072 { throw ClientServiceFailure(statusCode: 413, code: "RESOURCE_IMPORT_LIMIT") }
                }
                return data
            }.value
            try Task.checkCancellation()
            importedBytes = bytes; importedName = url.lastPathComponent
            importedType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if title.isEmpty { title = importedName }
        } catch is CancellationError { } catch { self.error = ResourceBrowserStore.message(error) }
    }
}
