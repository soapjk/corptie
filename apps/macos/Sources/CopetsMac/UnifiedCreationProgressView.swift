import SwiftUI
import CorptieConversation

/// A local pending conversation, never a fabricated backend Session. Its retained
/// draft owns the operation so removing this surface cannot cancel or navigate it.
struct UnifiedCreationProgressView<Footer: View>: View {
    @ObservedObject var draft: UnifiedCreationDraft
    let retry: () -> Void
    let open: () -> Void
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    MessageTextCard(messageID: draft.messageID, role: .user, timestamp: "",
                        showsActions: false, actionsAlwaysVisible: false, rendersStatusGlow: false, copy: {}) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(draft.submission?.text ?? draft.prompt).textSelection(.enabled)
                                ForEach(draft.submission?.imageURLs ?? [], id: \.self) { url in
                                    Label(url.lastPathComponent, systemImage: "photo")
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityIdentifier("creation-pending-first-message")
                    Label(L10n(draft.stage.title), systemImage: draft.stage == .completed ? "checkmark.circle" : "clock")
                        .font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("creation-pending-stage")
                    if let error = draft.error {
                        Text(error).foregroundStyle(.red).textSelection(.enabled)
                            .accessibilityIdentifier("creation-pending-error")
                        Button(L10n("重试原操作"), action: retry).disabled(draft.busy)
                    } else if draft.stage == .completed {
                        Button(L10n("进入会话"), action: open)
                    }
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            footer()
        }
        .accessibilityIdentifier("creation-pending-conversation")
        .onAppear { draft.followupEditor.resumePresentation() }
    }
}
