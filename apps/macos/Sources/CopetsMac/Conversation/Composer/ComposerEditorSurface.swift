import AppKit
import CorptieConversation
import SwiftUI
import Observation

/// The editor leaf owns geometry and suggestion state. Cursor/height/query
/// changes cannot invalidate the sibling toolbar or the whole composer.
struct ComposerEditorSurface: View {
    let sessionId: String
    let editorController: ComposerEditorController
    let backendClient: BackendClient
    let renderInputs: SessionPageRenderInputs?
    let legacyMentionCatalogRevision: UInt64
    let compact: Bool
    @Binding var hasSendableText: Bool
    @Binding var selectedMentions: [ConversationMention]
    let onPasteImages: (NSPasteboard) -> Bool
    let onSubmit: (ComposerDraftBuffer.Submission) -> Void

    @State private var inputHeight = ComposerInputLayout.minimumHeight
    @State private var mentions = ComposerMentionPresentation()
    private var mentionSearch: ComposerMentionSearch { mentions.search }

    private var acceptsPresentationUpdates: Bool { renderInputs?.acceptsPresentationUpdates ?? true }
    private var allowsActions: Bool {
        guard let renderInputs else { return true }
        return renderInputs.actionSession(generation: renderInputs.activity.generation) != nil
    }

    var body: some View {
        @Bindable var presentation = mentions
        return ComposerInputTextView(
            controller: editorController,
            placeholder: L10n("Send an instruction"),
            font: WorkbenchTypography.nativeFont(for: compact ? .compactComposerInput : .composerInput),
            textInsetHeight: compact ? CompactComposerLayout.textInsetHeight : ComposerShellMetrics.textInsetHeight,
            onFocusChange: { _ in },
            onSendableTextChange: { nextValue in
                if acceptsPresentationUpdates, hasSendableText != nextValue { hasSendableText = nextValue }
            },
            onContentHeightChange: { nextHeight in
                guard acceptsPresentationUpdates else { return }
                let resolved = compact ? CompactComposerLayout.resolvedInputHeight(nextHeight) : nextHeight
                if abs(inputHeight - resolved) > 0.5 { inputHeight = resolved }
            },
            onPasteImages: onPasteImages,
            onMentionQueryChange: updateMentionQuery,
            onMentionAnchorChange: { if acceptsPresentationUpdates { mentions.anchorPoint = $0 } },
            onMentionCommand: handleMentionCommand,
            onSubmit: onSubmit
        )
        .frame(height: compact ? CompactComposerLayout.resolvedInputHeight(inputHeight) : max(44, inputHeight))
        .popover(isPresented: $presentation.isPresented,
                 attachmentAnchor: .point(mentions.anchorPoint), arrowEdge: .bottom) {
            ComposerMentionMenu(search: mentionSearch, select: mentionSelection)
        }
        .task(id: mentionSearchRequest) {
            let request = mentionSearchRequest
            guard request.active, request.query != nil else { mentionSearch.invalidate(); return }
            await mentionSearch.search(request, sessionID: sessionId,
                sessions: renderInputs?.mentionSessions ?? backendClient.appState.sessions,
                works: renderInputs?.works ?? backendClient.appState.works,
                draft: editorController.draft.text)
        }
        .onChange(of: acceptsPresentationUpdates) { _, active in
            if !active { dismissMentions() }
        }
        .onChange(of: editorController.presentation.resetRevision) { _, _ in
            dismissMentions()
            if editorController.draft.text.isEmpty { inputHeight = ComposerInputLayout.minimumHeight }
        }
        .onDisappear { mentionSearch.invalidate() }
        .accessibilityHint(compact ? L10n("Press Return to send; Shift-Return for a new line") : "")
    }

    private var mentionSearchRequest: ComposerMentionSearch.Request {
        .init(query: mentions.query?.text,
              catalogRevision: renderInputs?.mentionCatalogRevision ?? legacyMentionCatalogRevision,
              draftRevision: mentions.draftRevision,
              selectedMentions: selectedMentions, active: acceptsPresentationUpdates)
    }

    private func updateMentionQuery(_ query: ComposerMentionQuery?) {
        guard acceptsPresentationUpdates else { return }
        if query != nil, mentions.draftRevision != editorController.draft.revision {
            mentions.draftRevision = editorController.draft.revision
        }
        guard query != mentions.query else { return }
        if query?.text != mentions.query?.text {
            mentionSearch.selectedIndex = 0
        }
        mentions.query = query
    }

    private func handleMentionCommand(_ command: ComposerMentionCommand) -> Bool {
        guard allowsActions, mentions.query != nil else { return false }
        switch command {
        case .move(let delta):
            guard !mentionSearch.matches.isEmpty else { return false }
            mentionSearch.move(delta)
        case .select:
            guard let candidate = mentionSearch.candidate(at: mentionSearch.selectedIndex) else {
                mentions.query = nil
                return false
            }
            mentionSelection(candidate)
        case .dismiss:
            mentions.query = nil
        }
        return true
    }

    private var mentionSelection: ComposerMentionSelectionAction {
        .init(controller: editorController, presentation: mentions, renderInputs: renderInputs,
              hasSendableText: $hasSendableText, selectedMentions: $selectedMentions)
    }


    private func dismissMentions() {
        mentions.dismiss()
    }
}

/// Keyboard and pointer selection share a focused action. It reads the current
/// query and activity at invocation rather than retaining a transient editor View.
@MainActor
struct ComposerMentionSelectionAction {
    let controller: ComposerEditorController
    let presentation: ComposerMentionPresentation
    let renderInputs: SessionPageRenderInputs?
    @Binding var hasSendableText: Bool
    @Binding var selectedMentions: [ConversationMention]

    func callAsFunction(_ candidate: ComposerMentionCandidate) {
        if let page = renderInputs {
            guard page.actionSession(generation: page.activity.generation) != nil else { return }
        }
        guard controller.isPresentationEnabled, let query = presentation.query,
              controller.draft.revision == presentation.draftRevision,
              controller.replaceMentionQuery(query, with: candidate.mention.displayName) else { return }
        if !selectedMentions.contains(where: { $0.id == candidate.mention.id }) {
            selectedMentions.append(candidate.mention)
            controller.draft.mentions = selectedMentions
        }
        presentation.dismiss()
        hasSendableText = true
        controller.draft.focusRequested = true
        controller.focusIfRequested()
    }
}

/// A stable projection for the popover binding. Closing the menu cancels its
/// current search immediately; no closure-backed Binding is rebuilt per frame.
@MainActor @Observable
final class ComposerMentionPresentation {
    var query: ComposerMentionQuery?
    var draftRevision: UInt64 = 0
    var anchorPoint = ComposerMentionAnchorPolicy.fallback
    let search = ComposerMentionSearch()

    var isPresented: Bool {
        get { query != nil && search.isPresented }
        set { if !newValue { dismiss() } }
    }

    func dismiss() {
        query = nil
        search.invalidate()
    }
}
