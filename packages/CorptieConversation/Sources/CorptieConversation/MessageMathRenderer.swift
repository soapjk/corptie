import Foundation
import SwiftMath
import CoreText
#if canImport(AppKit)
import AppKit
private typealias MathImage = NSImage
private typealias MathColor = NSColor
#else
import UIKit
private typealias MathImage = UIImage
private typealias MathColor = UIColor
#endif

/// Cached native typesetting, not a live embedded view. The attachment negotiates
/// its bounds with TextKit so measurement and drawing use identical geometry.
@MainActor
enum MessageMathRenderer {
    private static let cache: NSCache<NSString, MathImage> = {
        let value = NSCache<NSString, MathImage>()
        value.countLimit = 128
        value.totalCostLimit = 12 * 1024 * 1024
        return value
    }()
    private static let failures: NSCache<NSString, NSNumber> = {
        let value = NSCache<NSString, NSNumber>()
        value.countLimit = 128
        value.totalCostLimit = 256 * 1024
        return value
    }()

    static func attributed(_ formula: MessageMath.Formula, user: Bool) -> NSAttributedString? {
        let key = "v2|\(user)|\(formula.display)|\(formula.latex)" as NSString
        if failures.object(forKey: key) != nil { return nil }
        let image: MathImage
        if let cached = cache.object(forKey: key) { image = cached }
        else {
            guard let rendered = render(formula, user: user) else {
                failures.setObject(1, forKey: key, cost: key.length * 2 + 64)
                return nil
            }
            image = rendered
            cache.setObject(image, forKey: key, cost: Int(image.size.width * image.size.height * 32) + 1024)
        }
        let attachment = MessageMathAttachment(image: image, source: formula.source, display: formula.display)
        let value = NSMutableAttributedString(attachment: attachment)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = formula.display ? .center : .natural
        paragraph.paragraphSpacingBefore = formula.display ? 6 : 0
        paragraph.paragraphSpacing = formula.display ? 6 : 0
        value.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: value.length))
        return value
    }

    private static func render(_ formula: MessageMath.Formula, user: Bool) -> MathImage? {
        // Bound parser recursion and bitmap allocation for untrusted/streaming text.
        guard formula.latex.utf16.count <= 8192 else { return nil }
        var depth = 0
        var escaped = false
        for character in formula.latex {
            if escaped { escaped = false; continue }
            if character == "\\" { escaped = true; continue }
            if character == "{" { depth += 1; if depth > 64 { return nil } }
            if character == "}" { depth -= 1; if depth < 0 { return nil } }
        }
        guard depth == 0 else { return nil }
        let trimmed = formula.latex.trimmingCharacters(in: .whitespacesAndNewlines)
        // SwiftMath supports the inner expression; draw the outer \boxed frame
        // natively rather than losing this common final-result notation.
        var boxed = trimmed.hasPrefix(#"\boxed{"#) && trimmed.hasSuffix("}")
        if boxed {
            var groupDepth = 1
            for character in trimmed.dropFirst(7).dropLast() {
                if character == "{" { groupDepth += 1 }
                if character == "}" { groupDepth -= 1 }
                if groupDepth == 0 { boxed = false; break }
            }
        }
        let latex = boxed ? String(trimmed.dropFirst(7).dropLast()) : trimmed
        let fontSize: CGFloat = formula.display ? 15 : 12
        guard let prepared = MessageMathTextAdapter.prepare(latex) else { return nil }
        let measuringLabel = label(prepared: prepared, fontSize: fontSize, display: formula.display, color: .black)
        let measured = measuredSize(measuringLabel)
        guard measured.width.isFinite, measured.height.isFinite, measured.width > 0, measured.height > 0,
              measured.width <= 4096, measured.height <= 1024,
              (measured.width + 14) * (measured.height + 14) <= 131072 else { return nil }
        guard prepared.textRuns.isEmpty || hasCompleteGlyphCoverage(prepared, fontSize: fontSize) else { return nil }
        func foreground(_ dark: Bool) -> MathColor {
            guard user else { return dark ? .white : .black }
            let rgb = dark ? MessageTextCardPalette.darkUserForeground : MessageTextCardPalette.lightUserForeground
            return MathColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        }
        func make(_ color: MathColor) -> MathImage? {
            if !prepared.textRuns.isEmpty {
                return snapshot(prepared: prepared, size: measured, fontSize: fontSize, display: formula.display, color: color)
            }
            let renderer = MTMathImage(latex: latex, fontSize: fontSize, textColor: color,
                labelMode: formula.display ? .display : .text)
            let (error, image) = renderer.asImage()
            guard error == nil, let image, image.size.width.isFinite, image.size.height.isFinite,
                  image.size.width > 0, image.size.height > 0,
                  image.size.width <= 4096, image.size.height <= 1024 else { return nil }
            return image
        }
        guard let light = make(foreground(false)), let dark = make(foreground(true)) else { return nil }
        let padding: CGFloat = boxed ? 7 : 2
        let size = CGSize(width: ceil(light.size.width) + padding * 2, height: ceil(light.size.height) + padding * 2)
        #if canImport(AppKit)
        let adaptive = NSImage(size: size, flipped: false) { _ in
            let darkMode = NSAppearance.currentDrawing().bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let selected = darkMode ? dark : light
            selected.draw(in: CGRect(origin: CGPoint(x: padding, y: padding), size: light.size))
            if boxed {
                foreground(darkMode).setStroke()
                NSBezierPath(rect: CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5)).stroke()
            }
            return true
        }
        adaptive.cacheMode = .never
        return adaptive
        #else
        let asset = UIImageAsset()
        for (style, selected) in [(UIUserInterfaceStyle.light, light), (.dark, dark)] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 2
            let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
                selected.draw(at: CGPoint(x: padding, y: padding))
                if boxed {
                    context.cgContext.setStrokeColor(foreground(style == .dark).cgColor)
                    context.cgContext.stroke(CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5))
                }
            }
            asset.register(image, with: traits)
        }
        return asset.image(with: .current)
        #endif
    }

    private static func label(prepared: MessageMathTextAdapter.Prepared, fontSize: CGFloat,
                              display: Bool, color: MathColor) -> MTMathUILabel {
        let value = MTMathUILabel()
        value.displayErrorInline = false
        value.fontSize = fontSize
        value.labelMode = display ? .display : .text
        value.textAlignment = .left
        value.textColor = color
        value.mathList = prepared.copyList()
        return value
    }

    private static func measuredSize(_ label: MTMathUILabel) -> CGSize {
        #if canImport(AppKit)
        return label.fittingSize
        #else
        return label.intrinsicContentSize
        #endif
    }

    private static func layout(_ label: MTMathUILabel, size: CGSize) {
        label.frame = CGRect(origin: .zero, size: size)
        #if canImport(AppKit)
        label.layoutSubtreeIfNeeded()
        #else
        label.setNeedsLayout()
        label.layoutIfNeeded()
        #endif
    }

    /// Inspect a real CoreText line using the same math font and system fallback,
    /// not a glyph-count == character-count heuristic (CJK may use surrogate pairs).
    static func hasCompleteGlyphCoverage(_ prepared: MessageMathTextAdapter.Prepared, fontSize: CGFloat) -> Bool {
        guard let atom = prepared.prototype?.copy() else { return prepared.textRuns.isEmpty }
        let text = prepared.textRuns.joined(separator: " ")
        atom.nucleus = text; atom.subScript = nil; atom.superScript = nil
        let probe = MessageMathTextAdapter.Prepared(list: MTMathList(atom: atom), textRuns: [], prototype: nil)
        let view = label(prepared: probe, fontSize: fontSize, display: false, color: .black)
        let size = measuredSize(view)
        guard size.width > 0, size.height > 0 else { return false }
        layout(view, size: size)
        guard let line = view.displayList?.subDisplays.first as? MTCTLineDisplay,
              CTLineGetStringRange(line.line).length == text.utf16.count else { return false }
        let runs = CTLineGetGlyphRuns(line.line) as! [CTRun]
        guard !runs.isEmpty else { return false }
        for run in runs {
            let count = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
            guard !glyphs.contains(0) else { return false }
        }
        return true
    }

    /// Never feed the restored CJK tree back through the lossy string parser.
    /// Labels/display lists live only for cold rasterization, not in the cache.
    private static func snapshot(prepared: MessageMathTextAdapter.Prepared, size: CGSize, fontSize: CGFloat,
                                 display: Bool, color: MathColor) -> MathImage? {
        let view = label(prepared: prepared, fontSize: fontSize, display: display, color: color)
        layout(view, size: size)
        guard let list = view.displayList else { return nil }
        let canvas = CGSize(width: ceil(size.width), height: ceil(size.height))
        #if canImport(AppKit)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(canvas.width * 2),
            pixelsHigh: Int(canvas.height * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = graphics
        graphics.cgContext.scaleBy(x: 2, y: 2)
        list.draw(graphics.cgContext)
        guard let image = bitmap.cgImage else { return nil }
        return NSImage(cgImage: image, size: canvas)
        #else
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        return UIGraphicsImageRenderer(size: canvas, format: format).image { context in
            context.cgContext.translateBy(x: 0, y: canvas.height)
            context.cgContext.scaleBy(x: 1, y: -1)
            list.draw(context.cgContext)
        }
        #endif
    }
}

final class MessageMathAttachment: NSTextAttachment, @unchecked Sendable {
    let source: String
    private let naturalSize: CGSize
    private let display: Bool

    fileprivate init(image: MathImage, source: String, display: Bool) {
        self.source = source
        self.naturalSize = image.size
        self.display = display
        super.init(data: nil, ofType: nil)
        self.image = image
        bounds = CGRect(origin: .zero, size: image.size)
        #if canImport(UIKit)
        accessibilityLabel = source
        #endif
    }

    required init?(coder: NSCoder) { nil }

    override func attachmentBounds(for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect,
                                   glyphPosition position: CGPoint, characterIndex charIndex: Int) -> CGRect {
        let width = max(1, min(lineFrag.width, textContainer?.size.width ?? lineFrag.width))
        let scale = min(1, width / max(1, naturalSize.width))
        return CGRect(x: 0, y: display ? 0 : -3 * scale,
                      width: naturalSize.width * scale, height: naturalSize.height * scale)
    }
}
