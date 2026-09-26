import SwiftUI

struct SessionForkSelection: Identifiable {
    let sessionID: String
    let itemID: String
    var id: String { "\(sessionID):\(itemID)" }
}

struct SessionForkPreview: Decodable {
    let sourceBindingId: String
    let kind: String
    let suggestedTitle: String
    let workName: String?
    let agentName: String?
    let providerName: String
    let model: String?
    let reasoningLevel: String?
    let description: String
    let acceptanceCriteria: String
    let hasWorktree: Bool
}

struct SessionForkResponse: Decodable {
    let session: TaskSession
    let taskId: String?
}

struct SessionForkSheet: View {
    let selection: SessionForkSelection
    @ObservedObject var backendClient: BackendClient
    @Environment(\.dismiss) private var dismiss
    @State private var preview: SessionForkPreview?
    @State private var title = ""
    @State private var description = ""
    @State private var acceptanceCriteria = ""
    @State private var requestID = UUID().uuidString
    @State private var submitting = false
    @State private var errorText: String?
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(preview?.kind == "worker" ? "创建 Task 分支" : "创建 Chat 分支",
                  systemImage: "arrow.triangle.branch")
                .font(.headline)
            if let preview {
                Form {
                    TextField("名称", text: $title).focused($titleFocused)
                    EntityNameValidationMessage(value: title)
                    if let work = preview.workName { LabeledContent("Work", value: work) }
                    if let agent = preview.agentName { LabeledContent("Agent", value: agent) }
                    LabeledContent("模型", value: [preview.providerName, preview.model, preview.reasoningLevel]
                        .compactMap { $0 }.joined(separator: " · "))
                    if preview.kind == "worker" {
                        TextField("描述", text: $description, axis: .vertical).lineLimit(3...6)
                        TextField("验收标准", text: $acceptanceCriteria, axis: .vertical).lineLimit(2...5)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .disabled(submitting)
                Text(preview.hasWorktree
                     ? "保留至这一轮的对话，并复制当前工作区（含未提交修改）。创建后等待你输入新指令。"
                     : "保留至这一轮的对话。创建后等待你输入新指令。")
                    .font(.caption).foregroundStyle(.secondary)
            } else if errorText == nil {
                ProgressView("读取分叉信息…").controlSize(.small)
            }
            if let errorText {
                Text(errorText).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(submitting)
                Button {
                    Task { await create() }
                } label: {
                    if submitting { ProgressView().controlSize(.small) }
                    else { Text("创建分支") }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(preview == nil || !EntityNamePolicy.isValid(title) || submitting)
            }
        }
        .padding(22)
        .frame(width: 460)
        .interactiveDismissDisabled(submitting)
        .task(id: selection.id) {
            do {
                let value = try await backendClient.previewSessionFork(selection)
                preview = value
                title = value.suggestedTitle
                description = value.description
                acceptanceCriteria = value.acceptanceCriteria
                titleFocused = true
            } catch { errorText = error.localizedDescription }
        }
    }

    @MainActor private func create() async {
        guard let preview, !submitting else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            let result = try await backendClient.createSessionFork(selection, requestID: requestID,
                sourceBindingID: preview.sourceBindingId, title: title,
                description: description, acceptanceCriteria: acceptanceCriteria)
            backendClient.acceptCreatedSession(result.session, selectImmediately: false)
            backendClient.select(session: result.session, focusComposer: true)
            dismiss()
        } catch { errorText = error.localizedDescription }
    }
}
