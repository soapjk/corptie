import Testing
import Foundation
#if os(macOS)
import AppKit
import SwiftUI
@testable import CorptieConversation

@MainActor struct StampedParagraphTests {
    @Test func shortBodySharesFirstLineWithStampWithoutDisclosure() {
        let result = StampedParagraphLayout.make(title: "偏好", body: "使用中文回复", width: 300, expanded: false)
        #expect(!result.overflowing)
        #expect(result.text.attribute(.attachment, at: 0, effectiveRange: nil) is NSTextAttachment)
        #expect(StampedParagraphLayout.copyText(result.text) == "使用中文回复")
        #expect(lines(result.text, width: 300).count == 1)
    }

    @Test func collapsedDisclosureFitsAtEndOfThirdLineAndContinuationIsNotIndented() {
        for width in [180.0, 240.0, 375.0] {
            let source = String(repeating: "这是正文，包含详细描述和验收要求。", count: 80)
            let result = StampedParagraphLayout.make(title: "验收标准", body: source, width: width, expanded: false)
            let fragments = lines(result.text, width: width)
            #expect(result.overflowing)
            #expect(fragments.count == 3)
            #expect(result.text.string.hasSuffix(" …⌄"))
            #expect(fragments.dropFirst().allSatisfy { $0.rect.minX == 0 })
            let suffix = NSRange(location: result.text.length - 3, length: 3)
            #expect(NSIntersectionRange(fragments.last!.range, suffix).length == suffix.length)
            #expect(result.text.attribute(.link, at: result.text.length - 1, effectiveRange: nil) as? URL == StampedParagraphLayout.toggleURL)
            #expect(source.hasPrefix(StampedParagraphLayout.copyText(result.text)))
        }
    }

    @Test func expandedTextKeepsCompleteContentAndCopyExcludesUI() {
        let source = String(repeating: "第一条👨‍👩‍👧‍👦 e\u{301}\n第二条完整内容\n", count: 50)
        let expanded = StampedParagraphLayout.make(title: "描述", body: source, width: 280, expanded: true)
        #expect(StampedParagraphLayout.copyText(expanded.text) == source)
        #expect(expanded.text.string.hasSuffix(" ⌃"))
        #expect(lines(expanded.text, width: 280).count > 3)
        let collapsed = StampedParagraphLayout.make(title: "描述", body: source, width: 280, expanded: false)
        let visible = StampedParagraphLayout.copyText(collapsed.text)
        #expect(source.hasPrefix(visible))
        #expect(source.indices.contains(source.index(source.startIndex, offsetBy: visible.count)))
        #expect(!visible.contains("\u{FFFC}"))
    }

    @Test func explicitNewlinesAndWideStampDoNotCreateSeparateHeadingRows() {
        for title in ["偏好", "验收验证标准"] {
            let result = StampedParagraphLayout.make(title: title, body: "正文\n第二行\n第三行\n第四行", width: 240, expanded: false)
            #expect(result.overflowing)
            #expect(lines(result.text, width: 240).count <= 3)
            #expect(result.text.string.hasPrefix("\u{FFFC} 正文"))
        }
    }

    @Test func longMemoryPreviewRemainsBounded() {
        let source = String(repeating: "中文 memory 👨‍👩‍👧‍👦 ", count: 2000)
        let start = Date()
        for _ in 0..<20 {
            let result = StampedParagraphLayout.make(title: "偏好", body: source, width: 280, expanded: false)
            #expect(result.text.length < 300)
            #expect(result.size.height < 80)
        }
        #expect(Date().timeIntervalSince(start) < 3)
    }

    @Test func hostingKeepsBodyVisibleAndLinkExpandsAndCollapses() throws {
        final class Expansion { var value = false }
        for width in [240.0, 375.0, 768.0] {
            let expansion = Expansion()
            let source = String(repeating: "这是一段需要展开的记忆正文。", count: 100)
            let host = NSHostingView(rootView: ConversationStampedParagraph(title: "偏好", text: source,
                expansion: Binding(get: { expansion.value }, set: { expansion.value = $0 })).frame(width: width))
            host.frame = CGRect(x: 0, y: 0, width: width, height: 100)
            host.layoutSubtreeIfNeeded()
            func findText(_ view: NSView) -> NSTextView? {
                if let text = view as? NSTextView { return text }
                return view.subviews.compactMap(findText).first
            }
            let text = try #require(findText(host))
            #expect(text.string.contains("这是一段"))
            #expect(text.string.hasSuffix(" …⌄"))
            #expect(host.fittingSize.height < 90)
            let delegate = try #require(text.delegate)
            #expect(delegate.textView?(text, clickedOnLink: StampedParagraphLayout.toggleURL, at: text.string.utf16.count - 1) == true)
            #expect(expansion.value)
            #expect(delegate.textView?(text, clickedOnLink: StampedParagraphLayout.toggleURL, at: text.string.utf16.count - 1) == true)
            #expect(!expansion.value)
        }
    }

    @Test func memoryAndTaskPathsUseSharedParagraphWithoutRedundantLabels() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/CorptieConversation")
        let native = try String(contentsOf: directory.appendingPathComponent("ConversationNativeBusinessDetail.swift"), encoding: .utf8)
        #expect(!native.contains("命中时的内容快照"))
        #expect(!native.contains("title: \"内容\""))
        #expect(native.contains("NativeBusinessTextSection(title: kindTitle"))
        #expect(native.contains("ConversationStampedParagraph(title: title"))
        let task = try String(contentsOf: directory.appendingPathComponent("ConversationInspectorSection.swift"), encoding: .utf8)
        #expect(task.contains("ConversationStampedParagraph(title: titles[index]"))
    }

    private func lines(_ text: NSAttributedString, width: CGFloat) -> [(rect: CGRect, range: NSRange)] {
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        storage.addLayoutManager(layout); layout.addTextContainer(container)
        var result: [(CGRect, NSRange)] = []
        layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { rect, _, _, range, _ in
            result.append((rect, layout.characterRange(forGlyphRange: range, actualGlyphRange: nil)))
        }
        return result
    }
}
#endif
