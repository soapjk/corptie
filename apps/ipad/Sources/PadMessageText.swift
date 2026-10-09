import SwiftUI
import UIKit
import CorptieConversation
import CorptieClientCore

/// UIKit is only the selectable/measurable leaf. Markdown and card styling are shared.
struct PadMessageText: UIViewRepresentable {
    let text: String
    let fromUser: Bool
    var steps: [ConversationExecutionStep]? = nil
    var openLink: ((URL) -> Void)? = nil
    @Binding var isTextSelectionEnabled: Bool

    init(text: String, fromUser: Bool, steps: [ConversationExecutionStep]? = nil,
         isTextSelectionEnabled: Binding<Bool> = .constant(false), openLink: ((URL) -> Void)? = nil) {
        self.text = text
        self.fromUser = fromUser
        self.steps = steps
        self.openLink = openLink
        _isTextSelectionEnabled = isTextSelectionEnabled
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: String?
        var fromUser: Bool?
        var steps: [ConversationExecutionStep]?
        var isTextSelectionEnabled: Binding<Bool>?
        var openLink: ((URL) -> Void)?

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem,
                      defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content, let openLink else { return defaultAction }
            return UIAction { _ in openLink(url) }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            guard isTextSelectionEnabled?.wrappedValue == true else { return }
            isTextSelectionEnabled?.wrappedValue = false
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.openLink = openLink
        context.coordinator.isTextSelectionEnabled = $isTextSelectionEnabled
        configureTextSelection(view, enabled: isTextSelectionEnabled)
        // Width changes and unrelated workspace updates must not reparse Markdown.
        guard context.coordinator.text != text || context.coordinator.fromUser != fromUser
            || context.coordinator.steps != steps else { return }
        context.coordinator.text = text
        context.coordinator.fromUser = fromUser
        context.coordinator.steps = steps
        if let steps {
            view.attributedText = ExecutionTimelineAttributedText.make(steps: steps)
        } else {
            view.attributedText = PadMessageLayout.entry(text: text, style: fromUser ? .user : .agent).attributed
        }
        view.invalidateIntrinsicContentSize()
    }

    private func configureTextSelection(_ view: UITextView, enabled: Bool) {
        // Keep UITextView selectable so links continue to work, but suppress its
        // long-press recognizers until the user explicitly chooses “选择文本”.
        // The ancestor MessageTextCard context menu then owns the default long press.
        for case let recognizer as UILongPressGestureRecognizer in view.gestureRecognizers ?? [] {
            if recognizer.isEnabled != enabled { recognizer.isEnabled = enabled }
        }
        if !enabled, view.selectedRange.length > 0 {
            view.selectedRange = NSRange(location: 0, length: 0)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxAllowedWidth = MessageBubbleWidthPolicy.maximumWidth - MessageBubbleWidthPolicy.horizontalPadding
        let targetWidth: CGFloat
        if let width = proposal.width, width.isFinite, width > 0 {
            targetWidth = min(width, maxAllowedWidth)
        } else {
            targetWidth = maxAllowedWidth
        }
        let size = uiView.sizeThatFits(CGSize(width: targetWidth, height: .greatestFiniteMagnitude))
        return CGSize(width: min(targetWidth, ceil(size.width)), height: ceil(size.height))
    }
}
