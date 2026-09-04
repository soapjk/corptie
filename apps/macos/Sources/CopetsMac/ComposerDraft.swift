import AppKit
import Foundation

struct ComposerMentionQuery: Equatable {
    let replacementRange: NSRange
    let text: String

    static func resolve(in text: String, selection: NSRange) -> Self? {
        guard selection.length == 0 else { return nil }
        let value = text as NSString
        guard selection.location <= value.length else { return nil }
        let prefix = value.substring(to: selection.location) as NSString
        var index = prefix.length
        while index > 0 {
            let scalar = UnicodeScalar(prefix.character(at: index - 1))
            if scalar.map(CharacterSet.whitespacesAndNewlines.contains) == true { break }
            index -= 1
        }
        guard index < prefix.length, prefix.character(at: index) == 64 else { return nil }
        if index > 0 {
            let preceding = UnicodeScalar(prefix.character(at: index - 1))
            guard preceding.map(CharacterSet.whitespacesAndNewlines.contains) == true else { return nil }
        }
        let queryRange = NSRange(location: index + 1, length: prefix.length - index - 1)
        return Self(
            replacementRange: NSRange(location: index, length: prefix.length - index),
            text: prefix.substring(with: queryRange)
        )
    }
}

@MainActor
final class ComposerDraftRepository {
    private var draftsBySessionId: [String: ComposerDraftBuffer] = [:]

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

    init(draft: ComposerDraftBuffer) {
        self.draft = draft
    }

    func attach(_ textView: NSTextView) {
        self.textView = textView
    }

    func recordEditorText(_ text: String) {
        draft.updateFromEditor(text)
    }

    func replaceMentionQuery(_ query: ComposerMentionQuery, with displayName: String) {
        guard let textView, !textView.hasMarkedText() else { return }
        let replacement = "@\(displayName) "
        textView.insertText(replacement, replacementRange: query.replacementRange)
        recordEditorText(textView.string)
    }

    func submission() -> ComposerDraftBuffer.Submission? {
        if let textView {
            draft.updateFromEditor(textView.string)
        }
        return draft.submission()
    }

    @discardableResult
    func clear(ifUnchangedSince submission: ComposerDraftBuffer.Submission) -> Bool {
        guard draft.clear(ifUnchangedSince: submission) else {
            return false
        }
        if let textView, !textView.hasMarkedText() {
            textView.string = ""
            textView.setSelectedRange(NSRange(location: 0, length: 0))
            textView.needsDisplay = true
        }
        return true
    }

    @discardableResult
    func restoreAfterFailedSubmission(_ submission: ComposerDraftBuffer.Submission) -> Bool {
        guard draft.restoreAfterFailedSubmission(submission) else {
            return false
        }
        if let textView, !textView.hasMarkedText() {
            textView.string = submission.text
            textView.setSelectedRange(NSRange(location: submission.text.utf16.count, length: 0))
            textView.needsDisplay = true
        }
        return true
    }
}
