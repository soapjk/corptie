import SwiftUI
#if os(macOS)
import AppKit
private typealias ParagraphFont = NSFont
private typealias ParagraphColor = NSColor
#else
import UIKit
private typealias ParagraphFont = UIFont
private typealias ParagraphColor = UIColor
#endif

/// One text container: the category occupies only the start of the first line.
/// Disclosure is a link in the final line, not an overlay obscuring body text.
struct ConversationStampedParagraph: View {
    let title: String
    let text: String
    var expansion: Binding<Bool>?
    var expandLabel = "展开"
    var collapseLabel = "收起"
    @State private var localExpanded = false
    private var expanded: Binding<Bool> { expansion ?? $localExpanded }
    @ViewBuilder private var paragraph: some View {
        StampedParagraphNative(title: title, text: text, expanded: expanded)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    var body: some View {
        Group {
            if expanded.wrappedValue && text.count > 2000 {
                ScrollView(.vertical) { paragraph }.frame(height: 240)
            } else { paragraph }
        }
            .accessibilityAction(named: Text(expanded.wrappedValue ? collapseLabel : expandLabel)) {
                expanded.wrappedValue.toggle()
            }
    }
}

@MainActor
enum StampedParagraphLayout {
    static let toggleURL = URL(string: "corptie-detail://toggle")!
    static let synthetic = NSAttributedString.Key("corptie.paragraph.decoration")

    struct Result {
        let text: NSAttributedString
        let size: CGSize
        let overflowing: Bool
    }

    static func make(title: String, body: String, width: CGFloat, expanded: Bool) -> Result {
        let font = ParagraphFont.systemFont(ofSize: 12)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 2
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: ParagraphColor.secondaryLabelColorForParagraph,
            .paragraphStyle: paragraph
        ]
        let prefix = NSMutableAttributedString(string: "")
        if !title.isEmpty {
            let attachment = NSTextAttachment()
            let badge = badgeImage(title)
            attachment.image = badge
            attachment.bounds = CGRect(x: 0, y: -3, width: badge.size.width, height: badge.size.height)
            prefix.append(NSAttributedString(attachment: attachment))
            prefix.append(NSAttributedString(string: " ", attributes: attributes))
            prefix.addAttributes(attributes, range: NSRange(location: 0, length: prefix.length))
            prefix.addAttribute(synthetic, value: true, range: NSRange(location: 0, length: prefix.length))
        }
        let source = NSMutableAttributedString(attributedString: prefix)
        source.append(NSAttributedString(string: body, attributes: attributes))
        // TextKit may shape an entire paragraph even with maximumNumberOfLines.
        // Feed it a bounded prefix, growing only if a wide view needs more text.
        // Never split a composed character at this provisional boundary either.
        let string = source.string as NSString
        var probeLength = min(source.length, 512)
        var initial: (size: CGSize, lines: Int, visible: Int)
        while true {
            let range = string.rangeOfComposedCharacterSequences(for: NSRange(location: 0, length: probeLength))
            probeLength = NSMaxRange(range)
            initial = measure(source.attributedSubstring(from: range), width: width, lineLimit: 4)
            if initial.lines > 3 || initial.visible < probeLength || probeLength == source.length { break }
            probeLength = min(source.length, probeLength * 2)
        }
        let overflowing = initial.lines > 3 || initial.visible < source.length
        guard overflowing else { return Result(text: source, size: initial.size, overflowing: false) }
        func value(_ count: Int, suffix: String) -> NSAttributedString {
            let result = NSMutableAttributedString(attributedString: source.attributedSubstring(from: NSRange(location: 0, length: count)))
            let link = NSMutableAttributedString(string: suffix, attributes: attributes)
            link.addAttributes([.link: toggleURL, .foregroundColor: ParagraphColor.paragraphAccent,
                                synthetic: true], range: NSRange(location: 0, length: link.length))
            result.append(link)
            return result
        }
        if expanded {
            let result = value(source.length, suffix: " ⌃")
            return Result(text: result, size: measure(result, width: width).size, overflowing: true)
        }
        // Only enumerate composed characters in the visible prefix; never split
        // emoji, surrogate pairs or combining marks at the truncation boundary.
        var boundaries = [prefix.length]
        var cursor = prefix.length
        let end = min(source.length, initial.visible)
        while cursor < end {
            cursor = NSMaxRange(string.rangeOfComposedCharacterSequence(at: cursor))
            boundaries.append(cursor)
        }
        var low = 0, high = boundaries.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            let candidate = value(boundaries[middle], suffix: " …⌄")
            let measured = measure(candidate, width: width, lineLimit: 4)
            if measured.lines <= 3 && measured.visible == candidate.length { low = middle }
            else { high = middle - 1 }
        }
        let result = value(boundaries[low], suffix: " …⌄")
        return Result(text: result, size: measure(result, width: width).size, overflowing: true)
    }

    static func copyText(_ value: NSAttributedString) -> String {
        var result = ""
        value.enumerateAttribute(synthetic, in: NSRange(location: 0, length: value.length)) { marker, range, _ in
            if marker == nil { result += value.attributedSubstring(from: range).string }
        }
        return result
    }

    private static func measure(_ value: NSAttributedString, width: CGFloat, lineLimit: Int = 0)
        -> (size: CGSize, lines: Int, visible: Int) {
        let storage = NSTextStorage(attributedString: value)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(1, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = lineLimit
        storage.addLayoutManager(layout); layout.addTextContainer(container)
        let glyphs = layout.glyphRange(for: container)
        var lines = 0
        layout.enumerateLineFragments(forGlyphRange: glyphs) { _, _, _, _, _ in lines += 1 }
        let visible = NSMaxRange(layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil))
        return (CGSize(width: width, height: ceil(layout.usedRect(for: container).height) + 2), lines, visible)
    }

    #if os(macOS)
    private static func badgeImage(_ title: String) -> NSImage {
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor.controlAccentColor]
        let size = CGSize(width: ceil((title as NSString).size(withAttributes: attrs).width) + 8, height: 16)
        return NSImage(size: size, flipped: false) { rect in
            NSColor.controlAccentColor.withAlphaComponent(0.09).setFill()
            let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3)
            path.fill(); NSColor.controlAccentColor.withAlphaComponent(0.4).setStroke(); path.lineWidth = 0.5; path.stroke()
            (title as NSString).draw(at: CGPoint(x: 4, y: 2), withAttributes: attrs)
            return true
        }
    }
    #else
    private static func badgeImage(_ title: String) -> UIImage {
        let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: UIColor.systemBlue]
        let size = CGSize(width: ceil((title as NSString).size(withAttributes: attrs).width) + 8, height: 16)
        return UIGraphicsImageRenderer(size: size).image { _ in
            UIColor.systemBlue.withAlphaComponent(0.09).setFill()
            let path = UIBezierPath(roundedRect: CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5), cornerRadius: 3)
            path.fill(); UIColor.systemBlue.withAlphaComponent(0.4).setStroke(); path.lineWidth = 0.5; path.stroke()
            (title as NSString).draw(at: CGPoint(x: 4, y: 2), withAttributes: attrs)
        }
    }
    #endif
}

private extension ParagraphColor {
    static var secondaryLabelColorForParagraph: ParagraphColor {
        #if os(macOS)
        .secondaryLabelColor
        #else
        .secondaryLabel
        #endif
    }
    static var paragraphAccent: ParagraphColor {
        #if os(macOS)
        .controlAccentColor
        #else
        .systemBlue
        #endif
    }
}

/// Cache one layout per leaf, including width and appearance. No GeometryReader,
/// preference feedback loop, global observer, or repeated work on steady layout.
@MainActor private final class StampedParagraphCoordinator: NSObject {
    struct Key: Equatable {
        let title: String; let text: String; let width: CGFloat; let expanded: Bool; let appearance: String
    }
    var toggle: (() -> Void)?
    var key: Key?
    var result: StampedParagraphLayout.Result?
    func layout(title: String, text: String, width: CGFloat, expanded: Bool, appearance: String) -> StampedParagraphLayout.Result {
        let next = Key(title: title, text: text, width: width, expanded: expanded, appearance: appearance)
        if key == next, let result { return result }
        let result = StampedParagraphLayout.make(title: title, body: text, width: width, expanded: expanded)
        key = next; self.result = result
        return result
    }
}

#if os(macOS)
private final class StampedParagraphTextView: NSTextView {
    override func copy(_ sender: Any?) {
        let value = StampedParagraphLayout.copyText(attributedString().attributedSubstring(from: selectedRange()))
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string)
    }
}
extension StampedParagraphCoordinator: NSTextViewDelegate {
    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard (link as? URL) == StampedParagraphLayout.toggleURL else { return false }
        toggle?(); return true
    }
}
private struct StampedParagraphNative: NSViewRepresentable {
    let title: String; let text: String; @Binding var expanded: Bool
    func makeCoordinator() -> StampedParagraphCoordinator { StampedParagraphCoordinator() }
    func makeNSView(context: Context) -> StampedParagraphTextView {
        let view = StampedParagraphTextView()
        view.isEditable = false; view.isSelectable = true; view.drawsBackground = false
        view.textContainerInset = .zero; view.textContainer?.lineFragmentPadding = 0
        view.isHorizontallyResizable = false; view.isVerticallyResizable = true
        view.textContainer?.widthTracksTextView = true; view.delegate = context.coordinator
        view.linkTextAttributes = [.foregroundColor: NSColor.controlAccentColor]
        return view
    }
    func updateNSView(_ view: StampedParagraphTextView, context: Context) {
        context.coordinator.toggle = { expanded.toggle() }
        view.setAccessibilityLabel(title.isEmpty ? text : "\(title)：\(text)")
        if context.coordinator.key?.title != title || context.coordinator.key?.text != text
            || context.coordinator.key?.expanded != expanded
            || context.coordinator.key?.appearance != view.effectiveAppearance.name.rawValue {
            view.invalidateIntrinsicContentSize()
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: StampedParagraphTextView, context: Context) -> CGSize? {
        let proposed = proposal.width ?? 300
        let width = proposed.isFinite ? max(1, proposed) : 300
        let value = context.coordinator.layout(title: title, text: text, width: width, expanded: expanded,
            appearance: view.effectiveAppearance.name.rawValue)
        view.textContainer?.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        if !view.attributedString().isEqual(to: value.text) { view.textStorage?.setAttributedString(value.text) }
        return value.size
    }
}
#else
private final class StampedParagraphTextView: UITextView {
    override func copy(_ sender: Any?) {
        UIPasteboard.general.string = StampedParagraphLayout.copyText(attributedText.attributedSubstring(from: selectedRange))
    }
}
extension StampedParagraphCoordinator: UITextViewDelegate {
    func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
        guard URL == StampedParagraphLayout.toggleURL else { return false }
        toggle?(); return false
    }
}
private struct StampedParagraphNative: UIViewRepresentable {
    let title: String; let text: String; @Binding var expanded: Bool
    func makeCoordinator() -> StampedParagraphCoordinator { StampedParagraphCoordinator() }
    func makeUIView(context: Context) -> StampedParagraphTextView {
        let view = StampedParagraphTextView(usingTextLayoutManager: false)
        view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false
        view.backgroundColor = .clear; view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.delegate = context.coordinator; view.linkTextAttributes = [.foregroundColor: UIColor.systemBlue]
        return view
    }
    func updateUIView(_ view: StampedParagraphTextView, context: Context) {
        context.coordinator.toggle = { expanded.toggle() }
        view.accessibilityLabel = title.isEmpty ? text : "\(title)：\(text)"
        if context.coordinator.key?.title != title || context.coordinator.key?.text != text
            || context.coordinator.key?.expanded != expanded
            || context.coordinator.key?.appearance != "\(view.traitCollection.userInterfaceStyle.rawValue)" {
            view.invalidateIntrinsicContentSize()
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: StampedParagraphTextView, context: Context) -> CGSize? {
        let proposed = proposal.width ?? 300
        let width = proposed.isFinite ? max(1, proposed) : 300
        let value = context.coordinator.layout(title: title, text: text, width: width, expanded: expanded,
            appearance: "\(view.traitCollection.userInterfaceStyle.rawValue)")
        if !view.attributedText.isEqual(to: value.text) { view.attributedText = value.text }
        return value.size
    }
}
#endif
