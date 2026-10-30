#if canImport(AppKit)
import AppKit
import Testing
@testable import CorptieConversation

@Suite("Reading typography") @MainActor
struct ConversationTypographyTests {
    @Test func modelStrongEmphasisHandlesCJKPunctuationBesideText() throws {
        for typography in [ConversationTypography.classic, .codexReading] {
            for body in ["“带引号的文字”", "带括号（说明）", "文字。", "（含括号）", "English (note)", "“中文 `code`”"] {
                let rendered = MessageMarkdown.make(text: "前文**\(body)**后文", style: .agent, typography: typography)
                #expect(!rendered.string.contains("**"))
                #expect(!rendered.string.contains("CORPTIESTRONGBOUNDARY"))
                let target = body.contains("English") ? "English" : (body.contains("中文") ? "中文" : (body.contains("文字") ? "文字" : "括号"))
                let range = (rendered.string as NSString).range(of: target)
                let font = try #require(rendered.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont)
                #expect(NSFontManager.shared.traits(of: font).contains(.boldFontMask))
                let trailing = try #require(rendered.attribute(.font, at: rendered.length - 1, effectiveRange: nil) as? NSFont)
                #expect(!NSFontManager.shared.traits(of: trailing).contains(.boldFontMask))
            }
            let literal = "CORPTIESTRONGBOUNDARY 前文**“引号”**后文"
            let rendered = MessageMarkdown.make(text: literal, style: .agent, typography: typography)
            #expect(rendered.string == "CORPTIESTRONGBOUNDARY 前文“引号”后文")
            let partial = MessageMarkdown.make(text: "前文**“引号”", style: .agent, typography: typography)
            #expect(partial.string == "前文**“引号”")
        }
    }

    @Test func strongRepairPreservesLinksCodeAndEscapedMarkers() throws {
        let source = #"前文**“[链接](https://example.com/a**b**c)”**后文 `**“代码”**` \*\*“原样”\*\*"#
        let rendered = MessageMarkdown.make(text: source, style: .agent)
        #expect(rendered.string == "前文“链接”后文 **“代码”** **“原样”**")
        let linkRange = (rendered.string as NSString).range(of: "链接")
        #expect((rendered.attribute(.link, at: linkRange.location, effectiveRange: nil) as? URL)?.absoluteString == "https://example.com/a**b**c")
        let table = try #require(ConversationMarkdownTables.parse("| A |\n|---|\n| 前文**“加粗”**后文 |").compactMap {
            if case .table(let table) = $0.content { return table }; return nil
        }.first)
        let layout = ConversationMarkdownTableLayout.measured(table, width: 320)
        #expect(layout.cells[1][0].string == "前文“加粗”后文")
    }

    @Test func modelStrongEmphasisToleratesInnerWhitespaceInBothSkins() throws {
        for typography in [ConversationTypography.classic, .codexReading] {
            for body in ["文字", "English words", "文字 `code`"] {
                let rendered = MessageMarkdown.make(text: "前文 ** \(body) ** 后文", style: .agent, typography: typography)
                #expect(!rendered.string.contains("**"))
                let range = (rendered.string as NSString).range(of: body.hasPrefix("文字") ? "文字" : "English")
                let font = try #require(rendered.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont)
                #expect(NSFontManager.shared.traits(of: font).contains(.boldFontMask))
            }
            let partial = MessageMarkdown.make(text: "** 文字", style: .agent, typography: typography)
            #expect(partial.string.contains("**"))
            let code = MessageMarkdown.make(text: "`** 文字 **`", style: .agent, typography: typography)
            #expect(code.string == "** 文字 **")
            let escaped = MessageMarkdown.make(text: #"\*\* 文字 \*\*"#, style: .agent, typography: typography)
            #expect(escaped.string == "** 文字 **")
            let fenced = MessageMarkdown.make(text: "```\n** 文字 **\n```", style: .agent, typography: typography)
            #expect(fenced.string == "** 文字 **")
        }
    }

    @Test func classicRemainsDefaultAndFunctionalSurfacesStayCompact() {
        let text = "Hello **world**\n\nNext paragraph"
        let original = MessageMarkdown.make(text: text, style: .agent)
        #expect(original.isEqual(to: MessageMarkdown.make(text: text, style: .agent, typography: .classic)))
        #expect((original.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize == 11)
        for role in [ConversationSurfaceRole.inspector, .process, .plan, .interaction, .project, .composer] {
            #expect(ConversationSkin.codexFlat.typography(for: role) == .classic)
        }
    }
    @Test func readingBodyHeadingsCodeAndUserHaveDistinctMetrics() {
        for (style, size) in [(MessageMarkdown.Style.agent, CGFloat(16)), (.user, 15)] {
            let value = MessageMarkdown.make(text: "正文 English 😀\n\nNext", style: style, typography: .codexReading)
            #expect((value.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize == size)
            #expect((value.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.lineSpacing == (style == .agent ? 2 : 4))
        }
        let heading = MessageMarkdown.make(text: "# Heading", style: .agent, typography: .codexReading)
        #expect((heading.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize == 22)
        let code = MessageMarkdown.make(text: "```swift\nlet a = 1\n```", style: .agent, typography: .codexReading)
        #expect((code.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize == 13)
        let process = MessageMarkdown.make(text: "Tool", style: .process, typography: .codexReading)
        #expect((process.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize == 10.5)
    }
    @Test func paragraphSpacingKeepsCharacterOffsetsWithoutFullSizeBlankRows() {
        let source = "First paragraph\n\nSecond paragraph"
        let classic = MessageMarkdown.make(text: source, style: .agent)
        let reading = MessageMarkdown.make(text: source, style: .agent, typography: .codexReading)
        #expect(reading.string == classic.string)
        let emptyParagraph = (source as NSString).range(of: "\n\n").location + 1
        #expect((reading.attribute(.font, at: emptyParagraph, effectiveRange: nil) as? NSFont)?.pointSize == 1)
        #expect((reading.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacing == 6)
        #expect((classic.attribute(.font, at: emptyParagraph, effectiveRange: nil) as? NSFont)?.pointSize == 11)
    }
    @Test func tableCacheReplacesProfileWithoutReusingOldFonts() throws {
        let table = try #require(ConversationMarkdownTables.parse("| A | B |\n|---|---|\n| word | value |").compactMap {
            if case .table(let table) = $0.content { return table }; return nil
        }.first)
        let classic = ConversationMarkdownTableLayout.measured(table, width: 320)
        let reading = ConversationMarkdownTableLayout.measured(table, width: 320, typography: .codexReading)
        #expect((reading.cells[1][0].attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize == 14)
        #expect(reading !== classic)
        #expect(ConversationMarkdownTableLayout.measured(table, width: 320, typography: .codexReading) === reading)
        let restored = ConversationMarkdownTableLayout.measured(table, width: 320)
        #expect(restored.cells[1][0].isEqual(to: classic.cells[1][0]))
        #expect(restored.height == classic.height)
    }
    @Test func formulaImagesMatchTypographyAfterRoundTrip() throws {
        func attachment(_ typography: ConversationTypography) throws -> NSTextAttachment {
            let text = MessageMarkdown.make(text: "$$x^2 + y^2$$", style: .agent, typography: typography)
            return try #require(text.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment)
        }
        let small = try attachment(.classic)
        let large = try attachment(.codexReading)
        #expect(large.bounds.height > small.bounds.height)
        #expect(try attachment(.classic).bounds == small.bounds)
    }
}

#endif
