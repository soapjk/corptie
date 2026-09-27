import SwiftUI
import CorptieConversation

typealias CollapsibleDetailTextLayout = CorptieConversation.CollapsibleDetailTextLayout

struct CollapsibleDetailText: View {
    let text: String
    var collapsedLineLimit = 5
    var font: Font = .system(size: 12)
    var color: Color = .secondary
    var lineSpacing: CGFloat = 2
    var body: some View {
        ConversationDetailText(text: text, collapsedLineLimit: collapsedLineLimit, font: font,
            color: color, lineSpacing: lineSpacing, expandLabel: L10n("Expand"), collapseLabel: L10n("Collapse"))
    }
}
