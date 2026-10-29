#if canImport(AppKit)
import AppKit
import Testing
@testable import CorptieConversation

@Suite("Reading typography") @MainActor
struct ConversationTypographyTests {
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
            #expect((value.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.lineSpacing == 4)
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
        #expect((reading.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacing == 10)
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
