import AppKit
import XCTest
import CorptieConversation
@testable import CorptieMac

@MainActor
final class NativeMarkdownAttributedTextTests: XCTestCase {
    func testChineseFullStopStaysWithProseAcrossWindowWidths() throws {
        let source = "消息已经收到，但在开始执行前失败了：平台准备会话工具时，没有收到匹配的确认回执，所以模型尚未开始回答。我会继续核对工具配置与运行时状态，先确认能否恢复。"
        for typography in [ConversationTypography.classic, .codexReading] {
            let value = MessageMarkdown.make(text: source, style: .agent, typography: typography)
            XCTAssertEqual(value.string, source)
            let view = NativeTimelineTextView()
            view.textStorage?.setAttributedString(value)
            let manager = try XCTUnwrap(view.layoutManager)
            let container = try XCTUnwrap(view.textContainer)
            for width in stride(from: 120, through: 760, by: 1) {
                view.frame = NSRect(x: 0, y: 0, width: width, height: 2000)
                view.layout()
                manager.ensureLayout(for: container)
                var finalLine = ""
                manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, _, _, range, _ in
                    let characters = manager.characterRange(forGlyphRange: range, actualGlyphRange: nil)
                    finalLine = (source as NSString).substring(with: characters).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                XCTAssertNotEqual(finalLine, "。", "Orphan punctuation at width \(width)")
                XCTAssertEqual(NativeTextKitLayout.height(of: value, width: CGFloat(width)),
                    ceil(manager.usedRect(for: container).height))
            }
        }
    }

    func testProseStillWrapsLongURLsPathsAndInlineIdentifiersInsideTheViewport() throws {
        for source in ["https://example.com/" + String(repeating: "longsegment", count: 40),
                       "/tmp/" + String(repeating: "目录", count: 100) + "/Source.swift",
                       "`" + String(repeating: "identifier", count: 50) + "`"] {
            let value = MessageMarkdown.make(text: source, style: .agent, typography: .codexReading)
            let view = NativeTimelineTextView()
            view.textStorage?.setAttributedString(value)
            let manager = try XCTUnwrap(view.layoutManager)
            let container = try XCTUnwrap(view.textContainer)
            for width: CGFloat in [120, 240, 640] {
                view.frame = NSRect(x: 0, y: 0, width: width, height: 10000)
                view.layout()
                manager.ensureLayout(for: container)
                XCTAssertLessThanOrEqual(manager.usedRect(for: container).maxX, width + 1)
                XCTAssertEqual(manager.glyphRange(for: container).length, manager.numberOfGlyphs)
            }
        }
        let code = MessageMarkdown.make(text: "```\nlet literal = 1;\n```", style: .agent)
        let paragraph = try XCTUnwrap(code.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(paragraph.lineBreakMode, .byCharWrapping)
    }

    func testPreservesSemanticFontsAndLink() throws {
        let value = NativeMarkdownAttributedText.make(
            text: "**bold** *italic* `code` [link](https://example.com)",
            style: .agent
        )

        let boldFont = try XCTUnwrap(value.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        let italicLocation = (value.string as NSString).range(of: "italic").location
        let italicFont = try XCTUnwrap(value.attribute(.font, at: italicLocation, effectiveRange: nil) as? NSFont)
        let codeLocation = (value.string as NSString).range(of: "code").location
        let codeFont = try XCTUnwrap(value.attribute(.font, at: codeLocation, effectiveRange: nil) as? NSFont)
        let linkLocation = (value.string as NSString).range(of: "link").location
        let link = value.attribute(.link, at: linkLocation, effectiveRange: nil)

        XCTAssertTrue(NSFontManager.shared.traits(of: boldFont).contains(.boldFontMask))
        XCTAssertTrue(NSFontManager.shared.traits(of: italicFont).contains(.italicFontMask))
        XCTAssertTrue(codeFont.fontName.localizedCaseInsensitiveContains("mono"))
        XCTAssertNotNil(link)
    }

    func testPreservesSchemeLessLocalMarkdownDestinationForClickResolver() throws {
        let value = NativeMarkdownAttributedText.make(
            text: "[Source](/tmp/Source.swift:42:7)",
            style: .agent
        )
        let link = try XCTUnwrap(value.attribute(.link, at: 0, effectiveRange: nil) as? URL)

        XCTAssertNil(link.scheme)
        XCTAssertEqual(link.path, "/tmp/Source.swift:42:7")
    }

    func testPreservesBlockMarkdownStructure() {
        let source = """
        # Heading

        - first
        - second with **bold**

        1. ordered
        2. next

        > quoted

        ```swift
        let value = 42
        print(value)
        ```
        """

        let value = NativeMarkdownAttributedText.make(text: source, style: .agent)

        XCTAssertEqual(
            value.string,
            "Heading\n\n•  first\n•  second with bold\n\n1.  ordered\n2.  next\n\n│  quoted\n\nlet value = 42\nprint(value)"
        )
        let headingFont = value.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        let codeLocation = (value.string as NSString).range(of: "let value = 42").location
        let codeFont = value.attribute(.font, at: codeLocation, effectiveRange: nil) as? NSFont
        let codeBackground = value.attribute(.backgroundColor, at: codeLocation, effectiveRange: nil)
        let boldLocation = (value.string as NSString).range(of: "bold").location
        let boldFont = value.attribute(.font, at: boldLocation, effectiveRange: nil) as? NSFont

        XCTAssertNotNil(headingFont)
        XCTAssertTrue(headingFont.map { NSFontManager.shared.traits(of: $0).contains(.boldFontMask) } ?? false)
        XCTAssertTrue(codeFont?.fontName.localizedCaseInsensitiveContains("mono") == true)
        XCTAssertNotNil(codeBackground)
        XCTAssertTrue(boldFont.map { NSFontManager.shared.traits(of: $0).contains(.boldFontMask) } ?? false)
    }
}
