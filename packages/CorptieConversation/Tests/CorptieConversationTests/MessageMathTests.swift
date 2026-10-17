import Foundation
import Testing
@testable import CorptieConversation
#if canImport(AppKit)
import AppKit
#endif

private let volatilityExample = #"""
2. 波动率

先计算30个一分钟对数收益：

[
r_i=\ln\left(\frac{P_i}{P_{i-1}}\right),\qquad i=1,\ldots,30
]

再计算平均收益：

[
\bar r=\frac{1}{30}\sum_{i=1}^{30}r_i
]

最后取样本标准差，换算为基点：

[
\mathrm{Volatility}_{bps}
=
10{,}000
\sqrt{
\frac{\sum_{i=1}^{30}(r_i-\bar r)^2}{29}
}
]

当前策略要求：

[
\boxed{\mathrm{Volatility}_{bps}<3.4363870583}
]
"""#

@Suite @MainActor struct MessageMathTests {
    @Test func recognizesAllFourUserFormulasWithoutLosingSurroundingText() throws {
        let blocks = MessageMath.blocks(volatilityExample)
        let formulas = blocks.compactMap { block -> MessageMath.Formula? in
            if case .formula(let value) = block { return value }; return nil
        }
        #expect(formulas.count == 4)
        #expect(formulas[2].latex.contains(#"\sqrt{"#))
        #expect(formulas[3].latex.contains(#"\boxed{"#))
        let reconstructed = blocks.map { block in
            switch block { case .text(let text): text; case .formula(let value): value.source }
        }.joined()
        #expect(reconstructed == volatilityExample)
        let rendered = MessageMarkdown.make(text: volatilityExample, style: .agent)
        #expect(attachments(rendered).count == 4)
        #expect(rendered.string.contains("当前策略要求"))
        #expect(!rendered.string.contains(#"\sqrt"#))
    }

    @Test func standardDelimitersAndInlineMathAreSupported() {
        for source in ["\\[\nx^2+1\n\\]", "$$\nx^2+1\n$$", #"\[x^2+1\]"#, "$$x^2+1$$", #"收益为 \(r_i^2\)，还有 $P_i$。"#] {
            let rendered = MessageMarkdown.make(text: source, style: .agent)
            #expect(!attachments(rendered).isEmpty, "No formula for \(source)")
        }
    }

    @Test func codeCurrencyAndOrdinaryBracketsRemainText() {
        for source in ["[\n普通内容\n]", "[\n1, 2, 3\n]", "```latex\n[\n\\frac{1}{2}\n]\n```", "~~~~\n$$\nx^2\n$$\n~~~~", #"`$x^2$` and ``\(r_i\)``"#, #"价格 $30，另一个价格 $40。"#, #"转义 \$x\$"#] {
            #expect(attachments(MessageMarkdown.make(text: source, style: .agent)).isEmpty, "Unexpected formula for \(source)")
        }
    }

    @Test func incompleteInvalidAndExcessivelyNestedFormulasRemainReadable() {
        for source in ["[\n\\frac{1}{2}", "[\n\\notAValidMathCommand{x}\n]", "$$\n\\frac{1}{\n$$", "$$\n" + String(repeating: "{", count: 65) + "x" + String(repeating: "}", count: 65) + "\n$$"] {
            let rendered = MessageMarkdown.make(text: source, style: .agent)
            #expect(attachments(rendered).isEmpty)
            #expect(!rendered.string.isEmpty)
        }
    }

    @Test func textOnlyHostsDoNotReceiveInvisibleImageAttachments() {
        let source = #"结果 \(r_i^2\)"#
        let value = MessageMarkdown.make(text: source, style: .agent, rendersMath: false)
        #expect(attachments(value).isEmpty)
        #expect(value.string.contains("r_i"))
    }

    @Test func repeatedFormulaReusesTypesetImageAndRetainsCopySource() throws {
        let source = #"\[\frac{1}{30}\sum_{i=1}^{30}r_i\]"#
        let a = try #require(attachments(MessageMarkdown.make(text: source, style: .agent)).first)
        let b = try #require(attachments(MessageMarkdown.make(text: source, style: .agent)).first)
        #expect(a.image === b.image)
        #expect(a.source == source)
        #expect(MessageMarkdown.mathCopyText(from: MessageMarkdown.make(text: source, style: .agent)) == source)
        #expect(MessageMarkdown.mathImageCost(in: MessageMarkdown.make(text: source, style: .agent)) > 1024)
        #expect(MessageMarkdown.mathImageCost(in: MessageMarkdown.make(text: "plain text", style: .agent)) == 0)
    }

    #if canImport(AppKit)
    @Test func attachmentsFitNarrowTextKitContainersAndEveryGlyphIsLaidOut() {
        let value = MessageMarkdown.make(text: volatilityExample, style: .agent)
        for width: CGFloat in [120, 260, 460] {
            let storage = NSTextStorage(attributedString: value)
            let manager = NSLayoutManager()
            let container = NSTextContainer(containerSize: CGSize(width: width, height: 10000))
            container.lineFragmentPadding = 0
            manager.addTextContainer(container)
            storage.addLayoutManager(manager)
            manager.ensureLayout(for: container)
            #expect(manager.usedRect(for: container).width <= width + 1)
            #expect(manager.glyphRange(for: container).length == manager.numberOfGlyphs)
            for attachment in attachments(value) {
                let bounds = attachment.attachmentBounds(for: container, proposedLineFragment: CGRect(x: 0, y: 0, width: width, height: 1000), glyphPosition: .zero, characterIndex: 0)
                #expect(bounds.width <= width)
                #expect(bounds.height > 0)
            }
        }
    }
    #endif

    private func attachments(_ value: NSAttributedString) -> [MessageMathAttachment] {
        var result: [MessageMathAttachment] = []
        value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) { value, _, _ in
            if let attachment = value as? MessageMathAttachment { result.append(attachment) }
        }
        return result
    }
}
