import Foundation
import Testing
@testable import CorptieConversation
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif

@Suite @MainActor struct MessageCardSpacingTests {
    @Test func cardAndRowInsetsAreIndependent() {
        for height: CGFloat in [0, 13, 41.5, 300] {
            let card = MessageCardMetrics.cardHeight(contentHeight: height)
            #expect(card - height == 20)
            #expect(MessageCardMetrics.rowHeight(cardHeight: card, separatorHeight: 28) == card + 30)
        }
    }

    @Test func trimsOnlyExteriorBlankLines() {
        let value = MessageMarkdown.make(text: "\n \n正文\n\n第二段\n\t\n", style: .agent)
        #expect(value.string == "正文\n\n第二段")
        #expect(MessageMarkdown.make(text: "\n \n", style: .user).length == 0)
    }

    @Test func codeIndentationAndInteriorBlankLinesSurvive() {
        let value = MessageMarkdown.make(text: "\n```swift\n  let x = 1\n\n  print(x)\n```\n\n", style: .agent)
        #expect(value.string == "  let x = 1\n\n  print(x)")
        let blank = MessageMarkdown.make(text: "```\nvalue\n\n```", style: .user)
        #expect(blank.string == "value\n")
    }

    @Test func incompleteStreamingCodeKeepsItsTrailingBlankLines() {
        let value = MessageMarkdown.make(text: "```swift\n  let x = 1\n\n", style: .agent)
        #expect(value.string == "  let x = 1\n\n")
    }

    @Test func edgeHeadingSpacingDoesNotAffectInteriorHeadings() throws {
        let value = MessageMarkdown.make(text: "# 开始\n正文\n## 中间\n末尾\n# 结束", style: .agent)
        let first = try #require(value.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        let location = (value.string as NSString).range(of: "中间").location
        let middle = try #require(value.attribute(.paragraphStyle, at: location, effectiveRange: nil) as? NSParagraphStyle)
        let last = try #require(value.attribute(.paragraphStyle, at: value.length - 1, effectiveRange: nil) as? NSParagraphStyle)
        #expect(first.paragraphSpacingBefore == 0)
        #expect(first.paragraphSpacing == 4)
        #expect(middle.paragraphSpacingBefore == 5)
        #expect(middle.paragraphSpacing == 4)
        #expect(last.paragraphSpacingBefore == 8)
        #expect(last.paragraphSpacing == 0)
    }

    @Test func fragmentsRetainInternalWhitespaceAndParagraphSpacing() throws {
        let value = MessageMarkdown.make(text: "\n# 内部\n\n", style: .agent, boundary: [])
        #expect(value.string == "\n内部\n\n")
        let index = (value.string as NSString).range(of: "内部").location
        let style = try #require(value.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle)
        #expect(style.paragraphSpacingBefore == 8)
        #expect(style.paragraphSpacing == 4)
        #expect(MessageTextBoundary.fragment(index: 0, count: 3) == .start)
        #expect(MessageTextBoundary.fragment(index: 1, count: 3).isEmpty)
        #expect(MessageTextBoundary.fragment(index: 2, count: 3) == .end)
        #expect(MessageTextBoundary.fragment(index: 0, count: 1) == .both)
    }

    @Test func processFormattingAndSourceRemainUntouched() {
        let source = "\n  tool output\n\n"
        #expect(MessageMarkdown.make(text: source, style: .process).string == source)
        _ = MessageMarkdown.make(text: source, style: .user)
        #expect(source == "\n  tool output\n\n")
    }

    @Test func mathAndHardBreakSpacesRemainContent() {
        let value = MessageMarkdown.make(text: "\n正文  \n下一行\n", style: .user)
        #expect(value.string == "正文  \n下一行")
        let math = MessageMarkdown.make(text: "\n\\[\\frac{1}{2}\\]\n", style: .agent, rendersMath: false)
        #expect(math.string == "\\[\\frac{1}{2}\\]")
    }
}
