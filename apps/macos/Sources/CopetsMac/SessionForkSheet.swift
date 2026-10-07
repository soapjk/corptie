import CorptieClientCore
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
    let sourceSessionTitle: String
    let sourceTurnNumber: Int
    let sourceExcerpt: String
    let description: String
    let acceptanceCriteria: String
    let verificationCriteria: String
    let priority: String
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
    @State private var verificationCriteria = ""
    @State private var priority = "medium"
    @State private var requestID = UUID().uuidString
    @State private var submitting = false
    @State private var errorText: String?
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Label(preview?.kind == "worker" ? L10n("Create Task Branch") : L10n("Create Chat Branch"),
                  systemImage: "arrow.triangle.branch")
                .font(.headline)
                .padding(.bottom, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let preview {
                        sourceCard(preview)
                        VStack(alignment: .leading, spacing: 12) {
                            TextField(L10n("Name"), text: $title).focused($titleFocused)
                            EntityNameValidationMessage(value: title)
                            if let work = preview.workName { LabeledContent("Work", value: work) }
                            if let agent = preview.agentName { LabeledContent("Agent", value: agent) }
                            LabeledContent(L10n("Model"), value: [preview.providerName, preview.model, preview.reasoningLevel]
                                .compactMap { $0 }.joined(separator: " · "))
                            if preview.kind == "worker" {
                                editor(L10n("Description"), text: $description, height: 64)
                                editor(L10n("Acceptance Criteria"), text: $acceptanceCriteria, height: 74)
                                editor(L10n("Verification Criteria"), text: $verificationCriteria, height: 64)
                                Picker(L10n("Priority"), selection: $priority) {
                                    Text(L10n("Low")).tag("low")
                                    Text(L10n("Medium")).tag("medium")
                                    Text(L10n("High")).tag("high")
                                }
                                .frame(maxWidth: 220, alignment: .leading)
                            }
                        }
                        .textFieldStyle(.roundedBorder)
                        .disabled(submitting)
                        Label(preview.hasWorktree
                              ? L10n("History through this turn and the current workspace, including uncommitted changes, will be copied. No instruction will run automatically.")
                              : L10n("History through this turn will be copied. No instruction will run automatically."),
                              systemImage: "info.circle")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if errorText == nil {
                        ProgressView(L10n("Loading branch details…")).controlSize(.small)
                    }
                    if let errorText {
                        Label(errorText, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    }
                    if submitting {
                        ProgressView(preview?.kind == "worker"
                                     ? L10n("Creating Task, copying workspace, and forking history…")
                                     : L10n("Creating Chat and forking history…"))
                            .controlSize(.small)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider().padding(.vertical, 14)
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(submitting)
                Button(L10n("Create Branch")) { Task { await create() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(preview == nil || !EntityNamePolicy.isValid(title) || submitting)
            }
        }
        .padding(22)
        .frame(width: 520)
        .frame(minHeight: 420, idealHeight: 620, maxHeight: 720)
        .interactiveDismissDisabled(submitting)
        .task(id: selection.id) {
            do {
                let value = try await backendClient.previewSessionFork(selection)
                preview = value
                title = value.suggestedTitle
                description = value.description
                acceptanceCriteria = value.acceptanceCriteria
                verificationCriteria = value.verificationCriteria
                priority = value.priority
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
                description: description, acceptanceCriteria: acceptanceCriteria,
                verificationCriteria: verificationCriteria, priority: priority)
            OperationNotificationManager.shared.complete(.init(category: .environment, outcome: .succeeded, name: "Session fork", sessionID: result.session.id))
            backendClient.acceptCreatedSession(result.session, selectImmediately: false)
            backendClient.select(session: result.session, focusComposer: true)
            dismiss()
        } catch {
            OperationNotificationManager.shared.complete(.init(category: .environment, outcome: OperationNotificationOutcome.errorOutcome(error), name: "Session fork"))
            errorText = error.localizedDescription
        }
    }

    private func sourceCard(_ preview: SessionForkPreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(L10nFormat("Branch from %@ · Turn %d", preview.sourceSessionTitle, preview.sourceTurnNumber),
                  systemImage: "arrow.turn.down.right")
                .font(.caption.weight(.semibold))
            Text(preview.sourceExcerpt.isEmpty ? L10n("This turn has no text preview.") : preview.sourceExcerpt)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .textSelection(.enabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }

    private func editor(_ label: String, text: Binding<String>, height: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: text)
                .frame(height: height)
                .padding(5)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
        }
    }
}
