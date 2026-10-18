import Foundation
import Testing
import SwiftMath
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

    @Test func chineseSharpeFormulaNeverBecomesAnImageWithItsLabelsRemoved() {
        let source = #"\[夏普比率=\frac{平均超额收益}{收益波动率}\]"#
        let value = MessageMarkdown.make(text: source, style: .agent)
        // An image narrower than even one four-character label demonstrates
        // the old parser's silent dropping, rather than valid Chinese typesetting.
        if let attachment = attachments(value).first {
            #expect((attachment.image?.size.width ?? 0) > 80)
        } else {
            #expect(value.string == source)
        }
    }

    @Test func sharpeTreeRetainsEveryLabelAndANativeFraction() throws {
        let prepared = try #require(MessageMathTextAdapter.prepare(#"夏普比率=\frac{平均超额收益}{收益波动率}"#))
        #expect(prepared.textRuns == ["夏普比率", "平均超额收益", "收益波动率"])
        #expect(prepared.list.atoms.first?.nucleus == "夏普比率")
        let fraction = try #require(prepared.list.atoms.compactMap { $0 as? MTFraction }.first)
        #expect(fraction.numerator?.atoms.first?.nucleus == "平均超额收益")
        #expect(fraction.denominator?.atoms.first?.nucleus == "收益波动率")
        #expect(MessageMathRenderer.hasCompleteGlyphCoverage(prepared, fontSize: 15))
        #expect(MessageMathRenderer.hasCompleteGlyphCoverage(prepared, fontSize: 8))
        #if canImport(AppKit)
        let label = MTMathUILabel()
        label.fontSize = 15; label.mathList = prepared.copyList()
        label.frame = CGRect(origin: .zero, size: label.fittingSize)
        label.layoutSubtreeIfNeeded()
        #expect(label.displayList?.subDisplays.contains(where: { $0 is MTFractionDisplay }) == true)
        let text = label.displayList?.subDisplays.compactMap { $0 as? MTCTLineDisplay }
            .flatMap(\.atoms).map(\.nucleus).joined() ?? ""
        #expect(text.contains("夏普比率"))
        #endif
    }

    @Test func chineseNestedTextAndScriptsAreRestoredWithoutGlobalSymbols() throws {
        for latex in [
            #"\text{夏普比率}=\frac{\text{平均超额收益}}{\mathrm{收益波动率}}"#,
            #"收益_{净值}^{小时}=\sqrt{\frac{平均收益}{波动率}}"#,
            #"r_{收益}=\frac{收益}{风险}+收益"#,
            #"\left(收益\right)+\overline{平均收益}"#,
            #"\begin{matrix}收益&风险\\净值&回撤\end{matrix}"#
        ] {
            let prepared = try #require(MessageMathTextAdapter.prepare(latex))
            #expect(MessageMathRenderer.hasCompleteGlyphCoverage(prepared, fontSize: 15))
            let restored = treeText(prepared.list)
            for text in prepared.textRuns { #expect(restored.contains(text)) }
            #expect(!restored.contains("CORPTIEMATHTEXT"))
            let source = "\\[" + latex + "\\]"
            let value = MessageMarkdown.make(text: source, style: .agent)
            #expect(attachments(value).count == 1)
            #expect(MessageMarkdown.mathCopyText(from: value) == source)
        }
        let script = try #require(MessageMathTextAdapter.prepare(#"收益_{净值}^{小时}"#))
        #expect(script.list.atoms.first?.subScript?.atoms.first?.nucleus == "净值")
        #expect(script.list.atoms.first?.superScript?.atoms.first?.nucleus == "小时")
        let a = try #require(MessageMathTextAdapter.prepare("甲=乙"))
        _ = MessageMathTextAdapter.prepare("丙=丁")
        #expect(treeText(a.list) == "甲=乙")
    }

    @Test func unsupportedLiteralsAndCommandsFallbackAsExactSourceWithoutDamagingOtherFormulas() {
        for latex in [#"风险=🙂+1"#, #"x=\unknowncommand{收益}"#, #"\bar{收益}"#, "x=λ+1", "x#y", "x%y", "x~y"] {
            let source = "\\[" + latex + "\\]"
            let value = MessageMarkdown.make(text: source, style: .agent)
            #expect(attachments(value).isEmpty)
            #expect(value.string == source)
        }
        let source = "\\[\n收益=🙂\n\\]\n\n\\[\n风险=\\frac{收益}{本金}\n\\]"
        let mixed = MessageMarkdown.make(text: source, style: .agent)
        #expect(attachments(mixed).count == 1)
        #expect(mixed.string.contains("收益=🙂"))
        let textOnly = MessageMarkdown.make(text: source, style: .agent, rendersMath: false)
        #expect(attachments(textOnly).isEmpty)
        #expect(textOnly.string == source)
    }

    @Test func markersCannotCollideAndTextLimitsFailClosed() throws {
        let prepared = try #require(MessageMathTextAdapter.prepare("CORPTIEMATHTEXTAAEND+收益"))
        #expect(treeText(prepared.list).contains("收益"))
        #expect(treeText(prepared.list).contains("CORPTIEMATHTEXTAAEND"))
        #expect(MessageMathTextAdapter.prepare(String(repeating: "收益+", count: 129)) == nil)
        #expect(MessageMathTextAdapter.prepare(String(repeating: "{", count: 65) + "收益" + String(repeating: "}", count: 65)) == nil)
    }

    @Test func chineseColdAndWarmRenderingRemainCachedAndBounded() throws {
        let clock = ContinuousClock()
        let chinese = (0..<12).map { "\\[绩效基准=\\frac{平均超额收益}{收益波动率}+\($0)\\]" }
        let latin = (0..<12).map { "\\[S=\\frac{r_i}{s_i}+\($0)\\]" }
        let latinTime = clock.measure { for source in latin { _ = MessageMarkdown.make(text: source, style: .agent) } }
        var firstImage: NSAttributedString?
        let coldTime = clock.measure {
            for source in chinese {
                let value = MessageMarkdown.make(text: source, style: .agent)
                #expect(attachments(value).count == 1)
                #expect(MessageMarkdown.mathImageCost(in: value) <= 131072 * 32 + 1024)
                if firstImage == nil { firstImage = value }
            }
        }
        let warmTime = clock.measure {
            for _ in 0..<10 { for source in chinese { _ = MessageMarkdown.make(text: source, style: .agent) } }
        }
        let first = try #require(firstImage.flatMap { attachments($0).first })
        let repeated = try #require(attachments(MessageMarkdown.make(text: chinese[0], style: .agent)).first)
        #expect(first.image === repeated.image)
        print("math benchmark: latin cold 12=\(latinTime), CJK cold 12=\(coldTime), CJK warm 120=\(warmTime)")
    }

    private func treeText(_ list: MTMathList) -> String {
        list.atoms.map { atom in
            atom.nucleus + MessageMathTextAdapter.children(of: atom).map(treeText).joined()
        }.joined()
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
    @Test func chineseSnapshotContainsActualInkInBothAppearances() throws {
        let source = #"\[夏普比率=\frac{平均超额收益}{收益波动率}\]"#
        let attachment = try #require(attachments(MessageMarkdown.make(text: source, style: .agent)).first)
        let image = try #require(attachment.image)
        var brightness: [CGFloat] = []
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let appearance = try #require(NSAppearance(named: name))
            let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil,
                pixelsWide: Int(ceil(image.size.width * 2)), pixelsHigh: Int(ceil(image.size.height * 2)),
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            let context = try #require(NSGraphicsContext(bitmapImageRep: bitmap))
            appearance.performAsCurrentDrawingAppearance {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = context
                context.cgContext.scaleBy(x: 2, y: 2)
                image.draw(in: CGRect(origin: .zero, size: image.size))
                NSGraphicsContext.restoreGraphicsState()
            }
            var ink = 0
            var total: CGFloat = 0
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    if let color = bitmap.colorAt(x: x, y: y), color.alphaComponent > 0.5 {
                        ink += 1; total += color.redComponent
                    }
                }
            }
            #expect(ink > 300)
            brightness.append(total / CGFloat(max(1, ink)))
        }
        #expect(brightness[1] > brightness[0] + 0.5)
    }

    @Test func attachmentsFitNarrowTextKitContainersAndEveryGlyphIsLaidOut() {
      for source in [volatilityExample, #"\[夏普比率=\frac{平均超额收益}{收益波动率}\]"#] {
        let value = MessageMarkdown.make(text: source, style: .agent)
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
