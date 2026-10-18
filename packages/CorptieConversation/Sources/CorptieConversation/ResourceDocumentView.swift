import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
struct ResourceDocumentChunk: Identifiable {
    struct Block: Identifiable {
        let id: String
        let content: ConversationContentBlock
        let attributed: NSAttributedString?
    }
    let id: Int
    let text: String
    let blocks: [Block]
    init(id: Int, text: String) {
        self.id = id; self.text = text
        blocks = ConversationMarkdownTables.parse(text, messageID: "resource-chunk-\(id)").map { block in
            let attributed: NSAttributedString?
            if case .markdown(let text) = block.content { attributed = MessageMarkdown.make(text: text, style: .agent) }
            else { attributed = nil }
            return Block(id: block.id, content: block.content, attributed: attributed)
        }
    }
}

struct ResourceDocumentView: View {
    let chunk: ResourceDocumentChunk
    @State private var width: CGFloat = 300
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(chunk.blocks) { block in
                if let attributed = block.attributed { ResourceNativeText(value: attributed) }
                else if case .table(let table) = block.content {
                    ConversationMarkdownTableView(table: table, layout: .measured(table, width: width))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { proxy in Color.clear.preference(key: ResourceDocumentWidth.self, value: proxy.size.width) })
        .onPreferenceChange(ResourceDocumentWidth.self) { if abs(width - $0) > 1 { width = max(1, $0) } }
    }
}

@MainActor func copyResourceText(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}
private struct ResourceDocumentWidth: PreferenceKey {
    static let defaultValue: CGFloat = 300
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

#if os(macOS)
private final class ResourceTextView: NSTextView {
    override func copy(_ sender: Any?) {
        let value = attributedString().attributedSubstring(from: selectedRange())
        guard let source = MessageMarkdown.mathCopyText(from: value) else { super.copy(sender); return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(source, forType: .string)
    }
}
private struct ResourceNativeText: NSViewRepresentable {
    let value: NSAttributedString
    func makeNSView(context: Context) -> ResourceTextView {
        let view = ResourceTextView()
        view.isEditable = false; view.isSelectable = true; view.drawsBackground = false
        view.textContainerInset = .zero; view.textContainer?.lineFragmentPadding = 0
        view.isHorizontallyResizable = false; view.isVerticallyResizable = true
        view.textContainer?.widthTracksTextView = true
        view.textStorage?.setAttributedString(value)
        return view
    }
    func updateNSView(_ view: ResourceTextView, context: Context) {
        if !view.attributedString().isEqual(to: value) { view.textStorage?.setAttributedString(value) }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ResourceTextView, context: Context) -> CGSize? {
        let width = max(1, proposal.width ?? 300)
        guard let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height) + 2)
    }
}
#else
private final class ResourceTextView: UITextView {
    override func copy(_ sender: Any?) {
        let value = attributedText.attributedSubstring(from: selectedRange)
        guard let source = MessageMarkdown.mathCopyText(from: value) else { super.copy(sender); return }
        UIPasteboard.general.string = source
    }
}
private struct ResourceNativeText: UIViewRepresentable {
    let value: NSAttributedString
    func makeUIView(context: Context) -> ResourceTextView {
        let view = ResourceTextView()
        view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false
        view.backgroundColor = .clear; view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.attributedText = value
        return view
    }
    func updateUIView(_ view: ResourceTextView, context: Context) {
        if !view.attributedText.isEqual(to: value) { view.attributedText = value }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ResourceTextView, context: Context) -> CGSize? {
        let width = max(1, proposal.width ?? 300)
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
}
#endif
