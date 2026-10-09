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

/// The request must outlive the sheet so closing it cannot cancel a long fork.
@MainActor
final class SessionForkBackgroundOperation {
    static let shared = SessionForkBackgroundOperation()
    private var inFlight = Set<String>()

    func isRunning(_ requestID: String) -> Bool { inFlight.contains(requestID) }

    func run(requestID: String, operation: @escaping @MainActor () async -> Void) {
        guard inFlight.insert(requestID).inserted else { return }
        Task {
            defer { inFlight.remove(requestID) }
            await operation()
        }
    }
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
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider().padding(.vertical, 14)
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L10n("Create Branch")) { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(preview == nil || !EntityNamePolicy.isValid(title))
            }
        }
        .padding(22)
        .frame(width: 520)
        .frame(minHeight: 420, idealHeight: 620, maxHeight: 720)
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

    @MainActor private func create() {
        guard let preview, EntityNamePolicy.isValid(title) else { return }
        let selection = selection
        let requestID = requestID
        let sourceBindingID = preview.sourceBindingId
        let title = title
        let description = description
        let acceptanceCriteria = acceptanceCriteria
        let verificationCriteria = verificationCriteria
        let priority = priority
        let backendClient = backendClient
        SessionForkBackgroundOperation.shared.run(requestID: requestID) {
            do {
                let result = try await backendClient.createSessionFork(selection, requestID: requestID,
                    sourceBindingID: sourceBindingID, title: title,
                    description: description, acceptanceCriteria: acceptanceCriteria,
                    verificationCriteria: verificationCriteria, priority: priority)
                backendClient.acceptCreatedSession(result.session, selectImmediately: false)
                OperationNotificationManager.shared.complete(.init(category: .environment, outcome: .succeeded,
                    name: "Session fork", summary: title, sessionID: result.session.id))
            } catch {
                OperationNotificationManager.shared.complete(.init(category: .environment,
                    outcome: OperationNotificationOutcome.errorOutcome(error),
                    name: "Session fork", summary: error.localizedDescription))
            }
        }
        dismiss()
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
