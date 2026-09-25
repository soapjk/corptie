import SwiftUI
import UIKit
import CorptieConversation
import CorptieClientCore

/// UIKit is only the selectable/measurable leaf. Markdown and card styling are shared.
struct PadMessageText: UIViewRepresentable {
    let text: String
    let fromUser: Bool
    var steps: [ConversationExecutionStep]? = nil

    final class Coordinator {
        var text: String?
        var fromUser: Bool?
        var steps: [ConversationExecutionStep]?
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
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
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
