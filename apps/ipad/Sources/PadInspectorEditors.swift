#if os(iOS)
import SwiftUI
import CorptieClientCore
import CorptieConversation
import UniformTypeIdentifiers

struct PadInspectorExport: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

struct PadInspectorEdit: Identifiable {
    struct Input: Identifiable {
        var id: String { key }
        let key: String
        let label: String
        var multiline = false
        var choices: [(String, String)] = []
    }
    let id = UUID()
    let title: String
    let action: String
    var fields: [String: ClientInspectorValue] = [:]
    var inputs: [Input] = []
    var destructive = false
}

struct PadInspectorEditor: View {
    let edit: PadInspectorEdit
    let submit: ([String: ClientInspectorValue]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]
    var body: some View {
        NavigationStack {
            Form {
                ForEach(edit.inputs) { input in
                    Section(input.label) {
                        if !input.choices.isEmpty {
                            Picker(input.label, selection: binding(input.key)) {
                                Text("请选择").tag("")
                                ForEach(input.choices, id: \.0) { id, title in Text(title).tag(id) }
                            }
                        } else if input.multiline {
                            TextEditor(text: binding(input.key)).frame(minHeight: 160).accessibilityLabel(input.label)
                        } else {
                            TextField(input.label, text: binding(input.key)).textInputAutocapitalization(.never)
                        }
                    }
                }
            }
            .navigationTitle(edit.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("提交") {
                        var result = edit.fields
                        for input in edit.inputs {
                            if case .bool(let original) = edit.fields[input.key] {
                                result[input.key] = .bool(values[input.key].map { $0 == "true" } ?? original)
                            } else { result[input.key] = .string(values[input.key] ?? edit.fields[input.key]?.text ?? "") }
                        }
                        submit(result); dismiss()
                    }
                }
            }
        }
    }
    private func binding(_ key: String) -> Binding<String> {
        Binding(get: {
            if let value = values[key] { return value }
            if case .bool(let value) = edit.fields[key] { return value ? "true" : "false" }
            return edit.fields[key]?.text ?? ""
        }, set: { values[key] = $0 })
    }
}

struct PadInspectorDocument: Identifiable {
    let id = UUID()
    let title: String
    let resource: String
    let value: ClientInspectorValue
    var parameters: [String: ClientInspectorValue]
}

struct PadInspectorDocumentView: View {
    let document: PadInspectorDocument
    let connection: PadConnection
    let sessionID: String
    @Bindable var store: PadInspectorStore
    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var rows: [ClientInspectorValue] = []
    @State private var page: ClientInspectorValue = .null
    @State private var loading = false
    @State private var error: String?
    @State private var editor: PadInspectorEdit?
    @State private var confirmation: PadInspectorEdit?
    @State private var version: Double = 0
    @State private var parameters: [String: ClientInspectorValue] = [:]
    @State private var readGeneration = UUID()
    @State private var documentBytes = Data()
    @State private var exporting = false
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if document.resource == "artifact" {
                        Picker("版本", selection: $version) {
                            ForEach(document.value["versions"].items, id: \.inspectorVersionID) { item in
                                Text("v\(Int(item["version"].number ?? 0))").tag(item["version"].number ?? 0)
                            }
                        }
                        Text(parameters["contentHash"]?.text ?? "").font(.caption.monospaced()).textSelection(.enabled)
                        Text(content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        if page["encoding"].text == "base64" { Text("二进制文档，请完整加载后导出到文件查看。").font(.caption) }
                        artifactActions
                        DisclosureGroup("审计记录") {
                            ForEach(Array(document.value["audit"].items.enumerated()), id: \.offset) { _, item in
                                Text(item.formatted).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    } else {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            if document.resource == "trace" { traceRow(row) }
                            else {
                                Text(row.formatted).font(.caption.monospaced()).textSelection(.enabled)
                                if document.resource == "memory-audit", ["update", "revoke", "supersede"].contains(row["action"].text ?? "") {
                                    Button("回滚此变更", role: .destructive) {
                                        confirmation = .init(title: "将记忆恢复到此次变更前？", action: "memory.rollback",
                                            fields: ["id": document.value["id"], "auditId": row["id"], "expectedVersion": document.value["version"],
                                                     "confirmed": .bool(true)], destructive: true)
                                    }.disabled(store.busy || store.pending != nil)
                                }
                            }
                        }
                    }
                    if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                    if loading { ProgressView() }
                    if nextPage != .null { Button("加载更多") { Task { await load(reset: false) } }.disabled(loading) }
                }.padding(20)
            }
            .navigationTitle(document.title)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task(id: version) {
                if version == 0, let initial = document.parameters["version"]?.number {
                    version = initial
                    return
                }
                if version == document.parameters["version"]?.number || document.resource != "artifact" {
                    parameters = document.parameters
                } else {
                    let selected = document.value["versions"].items.first { $0["version"].number == version }
                    parameters = ["id": document.value["artifactId"], "version": .number(version), "contentHash": selected?["contentHash"] ?? .null]
                }
                parameters["readId"] = .string(document.id.uuidString)
                await load(reset: true)
            }
            .sheet(item: $editor) { edit in
                PadInspectorEditor(edit: edit) { fields in
                    Task { await store.command(edit.action, fields: fields, sessionID: sessionID, connection: connection) }
                }
            }
            .fileExporter(isPresented: $exporting, document: PadInspectorExport(data: documentBytes),
                contentType: UTType(mimeType: page["mimeType"].text ?? "") ?? .data,
                defaultFilename: document.title) { result in
                    if case .failure(let failure) = result { error = failure.localizedDescription }
                }
            .confirmationDialog(confirmation?.title ?? "确认", isPresented: Binding(
                get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
                if let command = confirmation {
                    Button(command.title, role: command.destructive ? .destructive : nil) {
                        confirmation = nil
                        Task { await store.command(command.action, fields: command.fields, sessionID: sessionID, connection: connection) }
                    }
                }
                Button("取消", role: .cancel) { confirmation = nil }
            }
        }
    }
    private var nextPage: ClientInspectorValue {
        document.resource == "artifact" ? page["range"]["nextOffset"] : page["nextCursor"]
    }
    private func load(reset: Bool) async {
        guard reset || !loading else { return }
        let generation = UUID()
        readGeneration = generation
        if reset { content = ""; documentBytes = Data(); rows = []; page = .null }
        loading = true; error = nil
        let requestedVersion = version
        defer { if readGeneration == generation { loading = false } }
        do {
            var request = parameters
            if !reset { request[document.resource == "artifact" ? "offset" : "cursor"] = nextPage }
            let api = ClientInspectorAPI(transport: try await connection.transport())
            let value = try await api.read(sessionID: sessionID, resource: document.resource, parameters: request)
            guard !Task.isCancelled, requestedVersion == version, readGeneration == generation else { return }
            page = value
            if document.resource == "artifact" {
                let text = value["content"].text ?? ""
                if value["encoding"].text == "base64" {
                    guard let bytes = Data(base64Encoded: text) else { throw ClientConnectionError.invalidResponse }
                    documentBytes.append(bytes)
                } else { documentBytes.append(Data(text.utf8)); content += text }
            }
            rows += value["items"].items
        } catch {
            guard !Task.isCancelled, readGeneration == generation else { return }
            self.error = PadWorktreeFailure.describe(error, stage: "读取\(document.title)")
        }
    }
    private func traceRow(_ row: ClientInspectorValue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row["operation"].text ?? "Trace").font(.headline)
            Text("\(row["intervalClass"].text ?? "") · \(row["status"].text ?? "")").font(.caption).foregroundStyle(.secondary)
            Text(row["spanId"].text ?? "").font(.caption.monospaced()).textSelection(.enabled)
            let duration = ConversationInspectorPolicy.spanDurationMilliseconds(
                start: row["startObservedAtUnixNano"].text ?? "", end: row["endObservedAtUnixNano"].text ?? "")
            Text(String(format: "%.2f ms", duration)).font(.caption.monospacedDigit())
            if let parent = row["parentSpanId"].text { Text("Parent: \(parent)").font(.caption2.monospaced()).textSelection(.enabled) }
        }
    }
    private var artifactActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button("导出到 iPad 文件") { exporting = true }.disabled(!page["complete"].flag || loading)
            Button("编辑并发布新版本") {
                var fields: [String: ClientInspectorValue] = ["id": document.value["artifactId"],
                    "expectedResourceVersion": document.value["resourceVersion"], "content": .string(content),
                    "title": document.value["title"], "summary": document.value["summary"]]
                if let reference = document.value["references"].items.first(where: { $0["taskId"].text == store.snapshot?.taskId && $0["revokedAt"] == .null }) {
                    fields["referenceId"] = reference["referenceId"]
                    fields["expectedPinnedVersion"] = reference["pinnedVersion"]
                    fields["expectedPinnedHash"] = reference["pinnedHash"]
                }
                editor = .init(title: "发布新版本", action: "artifact.publish", fields: fields,
                    inputs: [.init(key: "title", label: "标题"), .init(key: "summary", label: "摘要"), .init(key: "content", label: "正文", multiline: true)])
            }.disabled(!page["complete"].flag || loading || page["encoding"].text == "base64" || version != document.parameters["version"]?.number)
            ForEach(document.value["references"].items.filter { $0["taskId"].text == store.snapshot?.taskId && $0["revokedAt"] == .null }, id: \.inspectorID) { reference in
                Text("\(reference["relation"].text ?? "引用") · v\(Int(reference["pinnedVersion"].number ?? 0))\(reference["required"].flag ? " · 必需" : "")").font(.caption)
                if reference["pendingVersion"] != .null {
                    Button("确认更新影响（不自动改版本）") {
                        confirmation = .init(title: "确认已审查版本更新影响？", action: "artifact.acknowledge",
                            fields: ["id": reference["referenceId"], "confirmed": .bool(true)])
                    }
                }
                Button("移除此 Task 的引用", role: .destructive) {
                    confirmation = .init(title: "移除引用？", action: "artifact.unreference",
                        fields: ["id": reference["referenceId"], "confirmed": .bool(true)], destructive: true)
                }
            }
            Button("标记为已取代", role: .destructive) {
                confirmation = .init(title: "标记此 Artifact 已被取代？", action: "artifact.supersede",
                    fields: ["id": document.value["artifactId"], "confirmed": .bool(true)], destructive: true)
            }
            Button("撤销 Artifact", role: .destructive) {
                confirmation = .init(title: "撤销 Artifact？", action: "artifact.revoke",
                    fields: ["id": document.value["artifactId"], "confirmed": .bool(true)], destructive: true)
            }
        }.disabled(store.busy || store.pending != nil)
    }
}
extension ClientInspectorValue {
    var inspectorVersionID: Double { self["version"].number ?? 0 }
}
#endif
