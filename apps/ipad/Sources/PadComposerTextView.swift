import SwiftUI
import UIKit
import CorptieConversation

/// Programmatic handle onto the live editor: mention replacement at the query
/// range and focus requests. Text state itself stays in the workspace draft.
@MainActor
final class PadComposerEditor {
    fileprivate weak var textView: PadComposerTextView.SubmitTextView?

    func focus() { textView?.becomeFirstResponder() }

    /// Replaces `range` (UTF-16) with `replacement` and places the caret after it.
    func replace(_ range: NSRange, with replacement: String) {
        guard let textView,
              let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
              let end = textView.position(from: start, offset: range.length),
              let textRange = textView.textRange(from: start, to: end) else { return }
        textView.replace(textRange, withText: replacement)
        textView.selectedRange = NSRange(location: range.location + (replacement as NSString).length, length: 0)
        textView.noteProgrammaticChange()
    }
}

/// UIKit port of the desktop `ComposerInputTextView`: plain text, 12pt medium,
/// 30–96 auto-height, placeholder, image paste, cursor-anchored @ queries and
/// hardware-key semantics from `ComposerKeyPolicy`. The soft keyboard's Return
/// inserts a newline; the explicit send glyph submits.
struct PadComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let editor: PadComposerEditor
    var onHeightChange: (CGFloat) -> Void
    var onFocusChange: (Bool) -> Void
    var onSelectionChange: (String, NSRange) -> Void
    /// Returns true when the key was consumed (the text view then swallows it).
    var onKey: (ComposerKeyPolicy.Key, _ shift: Bool, _ hasMarkedText: Bool) -> Bool
    var onSubmit: () -> Void
    /// Allow the keyboard Send key for an image-only draft on iPhone.
    var allowsEmptyTextSubmission = false
    var onPasteImages: () -> Bool

    func makeUIView(context: Context) -> SubmitTextView {
        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.font = .systemFont(ofSize: ComposerShellMetrics.inputFontSize, weight: .medium)
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: ComposerShellMetrics.textInsetHeight, left: 0,
                                                   bottom: ComposerShellMetrics.textInsetHeight, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.showsHorizontalScrollIndicator = false
        textView.alwaysBounceVertical = false
        textView.keyboardDismissMode = .none
        textView.autocorrectionType = .default
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = !allowsEmptyTextSubmission
        textView.placeholder = placeholder
        textView.text = text
        textView.accessibilityIdentifier = "conversation-composer-input"
        textView.onFocusChange = onFocusChange
        textView.onHeightChange = onHeightChange
        textView.onKey = onKey
        textView.onPasteImages = onPasteImages
        textView.onContentChange = { [weak coordinator = context.coordinator] view in coordinator?.contentDidChange(view) }
        editor.textView = textView
        return textView
    }

    func updateUIView(_ textView: SubmitTextView, context: Context) {
        context.coordinator.parent = self
        textView.placeholder = placeholder
        textView.onFocusChange = onFocusChange
        textView.onHeightChange = onHeightChange
        textView.onKey = onKey
        textView.onPasteImages = onPasteImages
        let automaticallyEnablesReturnKey = !allowsEmptyTextSubmission
        if textView.enablesReturnKeyAutomatically != automaticallyEnablesReturnKey {
            textView.enablesReturnKeyAutomatically = automaticallyEnablesReturnKey
            if textView.isFirstResponder { textView.reloadInputViews() }
        }
        editor.textView = textView
        // Never fight the input method: a composing session owns the buffer.
        if textView.markedTextRange == nil, textView.text != text {
            textView.text = text
            textView.updatePlaceholder()
            textView.reportHeight()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PadComposerTextView
        init(parent: PadComposerTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            guard let view = textView as? SubmitTextView else { return }
            contentDidChange(view)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.onSelectionChange(textView.text ?? "", textView.selectedRange)
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text == "\n" {
                if textView.markedTextRange != nil { return true }
                if let submitView = textView as? SubmitTextView, submitView.isHardwareShiftReturn {
                    return true
                }
                parent.onSubmit()
                return false
            }
            return true
        }

        func contentDidChange(_ textView: SubmitTextView) {
            let value = textView.text ?? ""
            if parent.text != value { parent.text = value }
            textView.updatePlaceholder()
            textView.reportHeight()
            parent.onSelectionChange(value, textView.selectedRange)
        }
    }

    final class SubmitTextView: UITextView {
        var onFocusChange: ((Bool) -> Void)?
        var onHeightChange: ((CGFloat) -> Void)?
        var onKey: ((ComposerKeyPolicy.Key, Bool, Bool) -> Bool)?
        var onPasteImages: (() -> Bool)?
        var onContentChange: ((SubmitTextView) -> Void)?
        var placeholder = "" {
            didSet { placeholderLabel.text = placeholder }
        }
        private let placeholderLabel = UILabel()
        private var lastReportedHeight: CGFloat = 0
        private var lastLayoutWidth: CGFloat = 0
        private var consumedPresses = Set<ObjectIdentifier>()
        private(set) var isHardwareShiftReturn = false

        override init(frame: CGRect, textContainer: NSTextContainer?) {
            super.init(frame: frame, textContainer: textContainer)
            placeholderLabel.font = .systemFont(ofSize: ComposerShellMetrics.inputFontSize, weight: .medium)
            placeholderLabel.textColor = .secondaryLabel
            placeholderLabel.isUserInteractionEnabled = false
            placeholderLabel.isAccessibilityElement = false
            addSubview(placeholderLabel)
        }

        required init?(coder: NSCoder) { nil }

        override func layoutSubviews() {
            super.layoutSubviews()
            let size = placeholderLabel.intrinsicContentSize
            placeholderLabel.frame = CGRect(x: textContainerInset.left,
                                            y: max(0, (bounds.height - size.height) / 2),
                                            width: max(0, bounds.width - textContainerInset.left - textContainerInset.right),
                                            height: size.height)
            if bounds.width != lastLayoutWidth {
                lastLayoutWidth = bounds.width
                reportHeight()
            }
        }

        func updatePlaceholder() {
            placeholderLabel.isHidden = !(text?.isEmpty ?? true)
        }

        func noteProgrammaticChange() {
            onContentChange?(self)
        }

        /// Content height clamped by the shared 30–96 policy; only forwarded on change.
        func reportHeight() {
            guard bounds.width > 0 else { return }
            // UITextView may report extra empty-document padding on some iOS
            // versions; an empty draft should stay at the shared one-line size.
            let fitting = (text ?? "").isEmpty
                ? ComposerShellMetrics.minimumInputHeight
                : sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
            let resolved = ComposerShellMetrics.resolvedInputHeight(for: fitting)
            guard abs(resolved - lastReportedHeight) > 0.5 else { return }
            lastReportedHeight = resolved
            onHeightChange?(resolved)
        }

        // MARK: Focus

        @discardableResult
        override func becomeFirstResponder() -> Bool {
            let result = super.becomeFirstResponder()
            if result { onFocusChange?(true) }
            return result
        }

        @discardableResult
        override func resignFirstResponder() -> Bool {
            let result = super.resignFirstResponder()
            if result { onFocusChange?(false) }
            return result
        }

        // MARK: Hardware keys

        private static func key(for press: UIPress) -> ComposerKeyPolicy.Key? {
            switch press.key?.keyCode {
            case .keyboardReturnOrEnter, .keypadEnter: .return
            case .keyboardUpArrow: .upArrow
            case .keyboardDownArrow: .downArrow
            case .keyboardEscape: .escape
            default: nil
            }
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            var remaining = presses
            for press in presses {
                guard let key = Self.key(for: press), let onKey else { continue }
                let shift = press.key?.modifierFlags.contains(.shift) == true
                if key == .return, shift {
                    isHardwareShiftReturn = true
                }
                if onKey(key, shift, markedTextRange != nil) {
                    consumedPresses.insert(ObjectIdentifier(press))
                    remaining.remove(press)
                }
            }
            if !remaining.isEmpty { super.pressesBegan(remaining, with: event) }
        }

        override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            for press in presses {
                if Self.key(for: press) == .return {
                    isHardwareShiftReturn = false
                }
            }
            let remaining = presses.filter { consumedPresses.remove(ObjectIdentifier($0)) == nil }
            if !remaining.isEmpty { super.pressesEnded(Set(remaining), with: event) }
        }

        override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            for press in presses {
                if Self.key(for: press) == .return {
                    isHardwareShiftReturn = false
                }
            }
            let remaining = presses.filter { consumedPresses.remove(ObjectIdentifier($0)) == nil }
            if !remaining.isEmpty { super.pressesCancelled(Set(remaining), with: event) }
        }

        // MARK: Image paste

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)), UIPasteboard.general.hasImages, onPasteImages != nil { return true }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {
            let pasteboard = UIPasteboard.general
            if pasteboard.hasImages, !pasteboard.hasStrings, onPasteImages?() == true { return }
            super.paste(sender)
        }
    }
}
