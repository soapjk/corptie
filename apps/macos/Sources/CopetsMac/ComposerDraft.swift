import AppKit
import Foundation
import CorptieConversation

typealias ComposerMentionQuery = CorptieConversation.ComposerMentionQuery

@MainActor
final class ComposerDraftRepository {
    private static var pendingFocusSessionID: String?
    private static var focusDeadline = Date.distantPast

    static func requestUserFocus(for sessionID: String) {
        pendingFocusSessionID = sessionID
        focusDeadline = Date().addingTimeInterval(5)
        NotificationCenter.default.post(name: .consoleComposerFocusRequested, object: sessionID)
    }

    static func hasPendingFocus(for sessionID: String?) -> Bool {
        sessionID != nil && pendingFocusSessionID == sessionID && Date() < focusDeadline
    }

    static func consumeFocus(for sessionID: String?) {
        if pendingFocusSessionID == sessionID { pendingFocusSessionID = nil }
    }
    private var draftsBySessionId: [String: ComposerDraftBuffer] = [:]

    func requestFocus(for sessionId: String) {
        for draft in draftsBySessionId.values { draft.focusRequested = false }
        let draft = draft(for: sessionId)
        draft.focusRequested = true
        draft.focusEventNumber = NSApp.currentEvent?.eventNumber
        NotificationCenter.default.post(name: .consoleComposerFocusRequested, object: sessionId)
    }

    func draft(for sessionId: String) -> ComposerDraftBuffer {
        if let draft = draftsBySessionId[sessionId] {
            return draft
        }
        let draft = ComposerDraftBuffer()
        draftsBySessionId[sessionId] = draft
        return draft
    }

    func retainDrafts(for sessionIds: Set<String>) {
        draftsBySessionId = draftsBySessionId.filter { sessionIds.contains($0.key) }
    }
}

@MainActor
final class ComposerDraftBuffer {
    var focusRequested = false
    var focusEventNumber: Int?
    var sessionId: String?
    var images: [ChatImageReference] = []
    var mentions: [ConversationMention] = []
    struct Submission: Equatable {
        let text: String
        let revision: UInt64
    }

    private(set) var text: String
    private(set) var revision: UInt64

    init(text: String = "", revision: UInt64 = 0) {
        self.text = text
        self.revision = revision
    }

    var hasSendableText: Bool {
        text.rangeOfCharacter(from: CharacterSet.whitespacesAndNewlines.inverted) != nil
    }

    @discardableResult
    func updateFromEditor(_ nextText: String) -> Bool {
        guard text != nextText else {
            return false
        }
        text = nextText
        revision &+= 1
        return true
    }

    func submission() -> Submission? {
        guard hasSendableText else {
            return nil
        }
        return Submission(text: text, revision: revision)
    }

    @discardableResult
    func clear(ifUnchangedSince submission: Submission) -> Bool {
        guard revision == submission.revision, text == submission.text else {
            return false
        }
        text = ""
        revision &+= 1
        return true
    }

    @discardableResult
    func restoreAfterFailedSubmission(_ submission: Submission) -> Bool {
        guard revision == submission.revision &+ 1, text.isEmpty else {
            return false
        }
        text = submission.text
        revision &+= 1
        return true
    }
}

@MainActor
final class ComposerEditorController {
    let draft: ComposerDraftBuffer
    private weak var textView: NSTextView?
    private(set) var isPresentationEnabled = true
    private(set) var presentationGeneration: UInt64 = 0
    private var presentedDraftRevision: UInt64
    var permitsFocus: (() -> Bool)?
    var permitsDraftUpdates: (() -> Bool)?
    var onPresentationResume: (() -> Void)?

    init(draft: ComposerDraftBuffer) {
        self.draft = draft
        presentedDraftRevision = draft.revision
    }

    func attach(_ textView: NSTextView) {
        if self.textView !== textView {
            self.textView = textView
            presentedDraftRevision = draft.revision
        }
        if textView.isEditable != isPresentationEnabled { textView.isEditable = isPresentationEnabled }
        focusIfRequested()
    }

    func suspendPresentation() {
        guard isPresentationEnabled else { return }
        isPresentationEnabled = false; presentationGeneration &+= 1
        draft.focusRequested = false
        ComposerDraftRepository.consumeFocus(for: draft.sessionId)
        if textView?.hasMarkedText() != true { textView?.isEditable = false }
    }
    func resumePresentation() {
        guard !isPresentationEnabled else { return }
        isPresentationEnabled = true; presentationGeneration &+= 1
        if let textView {
            if presentedDraftRevision != draft.revision, !textView.hasMarkedText() {
                if textView.string != draft.text {
                    textView.string = draft.text
                    textView.setSelectedRange(NSRange(location: draft.text.utf16.count, length: 0))
                }
                presentedDraftRevision = draft.revision
            }
            textView.isEditable = true
        }
        onPresentationResume?()
        focusIfRequested()
    }
    /// End composition through AppKit. A refused resignation blocks the
    /// switch; never copy unconfirmed marked text into another Session.
    func finishEditingForSessionSwitch() -> Bool {
        guard let textView else { return true }
        guard let window = textView.window else { return !textView.hasMarkedText() }
        if window.firstResponder !== textView { return !textView.hasMarkedText() }
        guard window.makeFirstResponder(nil) else { return false }
        guard !textView.hasMarkedText() else {
            window.makeFirstResponder(textView)
            return false
        }
        recordEditorText(textView.string)
        return true
    }

    func focusIfRequested() {
        guard isPresentationEnabled,
              draft.focusRequested || ComposerDraftRepository.hasPendingFocus(for: draft.sessionId) else { return }
        let generation = presentationGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.isPresentationEnabled, self.presentationGeneration == generation,
                  self.draft.focusRequested || ComposerDraftRepository.hasPendingFocus(for: self.draft.sessionId),
                  let textView = self.textView, !textView.isHiddenOrHasHiddenAncestor,
                  let window = textView.window, window.isKeyWindow else { return }
            let ownsFocus = self.permitsFocus?() ?? (BackendClient.shared.selectedSession?.id == self.draft.sessionId)
            guard ownsFocus,
                  textView.isEditable else {
                self.draft.focusRequested = false
                return
            }
            self.draft.focusRequested = false
            ComposerDraftRepository.consumeFocus(for: self.draft.sessionId)
            window.makeFirstResponder(textView)
        }
    }

    func recordEditorText(_ text: String) {
        guard permitsDraftUpdates?() ?? true else { return }
        draft.updateFromEditor(text)
        presentedDraftRevision = draft.revision
    }

    func replaceMentionQuery(_ query: ComposerMentionQuery, with displayName: String) {
        guard let textView, !textView.hasMarkedText() else { return }
        let replacement = "@\(displayName) "
        textView.insertText(replacement, replacementRange: query.replacementRange)
        recordEditorText(textView.string)
    }

    func submission() -> ComposerDraftBuffer.Submission? {
        if let textView {
            guard !textView.hasMarkedText() else { return nil }
            draft.updateFromEditor(textView.string)
            presentedDraftRevision = draft.revision
        }
        return draft.submission()
    }

    @discardableResult
    func clear(ifUnchangedSince submission: ComposerDraftBuffer.Submission) -> Bool {
        guard draft.clear(ifUnchangedSince: submission) else {
            return false
        }
        if isPresentationEnabled, let textView, !textView.hasMarkedText() {
            textView.string = ""
            textView.setSelectedRange(NSRange(location: 0, length: 0))
            textView.needsDisplay = true
            presentedDraftRevision = draft.revision
        }
        return true
    }

    @discardableResult
    func restoreAfterFailedSubmission(_ submission: ComposerDraftBuffer.Submission) -> Bool {
        guard draft.restoreAfterFailedSubmission(submission) else {
            return false
        }
        if isPresentationEnabled, let textView, !textView.hasMarkedText() {
            textView.string = submission.text
            textView.setSelectedRange(NSRange(location: submission.text.utf16.count, length: 0))
            textView.needsDisplay = true
            presentedDraftRevision = draft.revision
        }
        return true
    }
}
