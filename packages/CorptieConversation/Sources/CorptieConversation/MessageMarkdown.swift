import Foundation
#if canImport(AppKit)
import AppKit
private typealias MessageFont = NSFont
private typealias MessageColor = NSColor
#else
import UIKit
private typealias MessageFont = UIFont
private typealias MessageColor = UIColor
#endif

/// One Markdown implementation for both clients; only native fonts/colors differ.
@MainActor
public enum MessageMarkdown {
    public enum Style: Sendable { case user, agent, process }
    private static let unorderedListItemRegex = try! NSRegularExpression(pattern: #"^(\s*)[-+*]\s+(.+)$"#)
    private static let orderedListItemRegex = try! NSRegularExpression(pattern: #"^(\s*)(\d+)[.)]\s+(.+)$"#)

    public static func make(
        text: String,
        style: Style
    ) -> NSAttributedString {
        let baseFont: MessageFont = switch style {
        case .user, .agent: .systemFont(ofSize: 11, weight: .medium)
        case .process: .systemFont(ofSize: 10.5, weight: .semibold)
        }
        let color = style == .user ? MessageTextCardPalette.userNativeForeground : secondaryText
        guard style != .process else {
            return NSAttributedString(string: text, attributes: [.font: baseFont, .foregroundColor: color])
        }

        let attributed = NSMutableAttributedString(string: "")
        var inCodeFence = false
        let lines = text.components(separatedBy: "\n")
        for (index, sourceLine) in lines.enumerated() {
            let line = sourceLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                inCodeFence.toggle()
            } else if inCodeFence {
                attributed.append(blockLine(
                    sourceLine,
                    font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                    color: color,
                    backgroundColor: codeBackground,
                    headIndent: 8,
                    tailIndent: -8
                ))
            } else if let heading = heading(in: sourceLine) {
                attributed.append(blockLine(
                    heading.text,
                    baseFont: .systemFont(
                        ofSize: max(14, 21 - CGFloat(heading.level * 2)),
                        weight: .bold
                    ),
                    color: color,
                    paragraphSpacingBefore: heading.level == 1 ? 8 : 5,
                    paragraphSpacing: 4
                ))
            } else if let listItem = unorderedListItem(in: sourceLine) {
                attributed.append(blockLine(
                    "\(String(repeating: "  ", count: listItem.depth))•  \(listItem.text)",
                    baseFont: baseFont,
                    color: color,
                    headIndent: CGFloat(listItem.depth * 14),
                    firstLineHeadIndent: CGFloat(listItem.depth * 14)
                ))
            } else if let listItem = orderedListItem(in: sourceLine) {
                attributed.append(blockLine(
                    "\(String(repeating: "  ", count: listItem.depth))\(listItem.ordinal).  \(listItem.text)",
                    baseFont: baseFont,
                    color: color,
                    headIndent: CGFloat(listItem.depth * 14),
                    firstLineHeadIndent: CGFloat(listItem.depth * 14)
                ))
            } else if let quote = blockQuote(in: sourceLine) {
                attributed.append(blockLine(
                    "│  \(quote)",
                    baseFont: baseFont,
                    color: quoteColor,
                    headIndent: 8,
                    firstLineHeadIndent: 0
                ))
            } else if isThematicBreak(sourceLine) {
                attributed.append(blockLine("────────", baseFont: baseFont, color: separatorColor))
            } else {
                attributed.append(blockLine(sourceLine, baseFont: baseFont, color: color))
            }
            if index < lines.count - 1, !(line.hasPrefix("```") || line.hasPrefix("~~~")) {
                attributed.append(NSAttributedString(string: "\n", attributes: [.font: baseFont]))
            }
        }
        return attributed
    }

    private static func blockLine(
        _ text: String,
        baseFont: MessageFont? = nil,
        font: MessageFont? = nil,
        color: MessageColor,
        backgroundColor: MessageColor? = nil,
        headIndent: CGFloat = 0,
        firstLineHeadIndent: CGFloat? = nil,
        tailIndent: CGFloat = 0,
        paragraphSpacingBefore: CGFloat = 0,
        paragraphSpacing: CGFloat = 0
    ) -> NSAttributedString {
        let effectiveFont = font ?? baseFont ?? .systemFont(ofSize: 13)
        let attributed: NSMutableAttributedString
        if font == nil,
           let parsed = try? AttributedString(
               markdown: text,
               options: .init(
                   interpretedSyntax: .inlineOnlyPreservingWhitespace,
                   failurePolicy: .returnPartiallyParsedIfPossible
               )
           ) {
            attributed = NSMutableAttributedString(parsed)
        } else {
            attributed = NSMutableAttributedString(string: text)
        }
        let fullRange = NSRange(location: 0, length: attributed.length)
        attributed.addAttributes([.font: effectiveFont, .foregroundColor: color], range: fullRange)
        if let backgroundColor {
            attributed.addAttribute(.backgroundColor, value: backgroundColor, range: fullRange)
        }
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.headIndent = headIndent
        paragraphStyle.firstLineHeadIndent = firstLineHeadIndent ?? headIndent
        paragraphStyle.tailIndent = tailIndent
        paragraphStyle.paragraphSpacingBefore = paragraphSpacingBefore
        paragraphStyle.paragraphSpacing = paragraphSpacing
        // Chat messages regularly contain URLs, hashes, file paths, and model
        // identifiers with no whitespace. Word wrapping lets those runs escape
        // the fixed card width; character wrapping preserves the card boundary.
        paragraphStyle.lineBreakMode = .byCharWrapping
        attributed.addAttribute(.paragraphStyle, value: paragraphStyle, range: fullRange)
        let inlineIntentKey = NSAttributedString.Key("NSInlinePresentationIntent")
        attributed.enumerateAttribute(inlineIntentKey, in: fullRange) { value, range, _ in
            guard let rawIntent = value as? NSNumber else { return }
            let intent = rawIntent.intValue
            let isCode = intent & 4 != 0
            let isStrong = intent & 2 != 0
            let isEmphasized = intent & 1 != 0
            let isStrikethrough = intent & 64 != 0
            let font: MessageFont
            if isCode {
                font = .monospacedSystemFont(ofSize: effectiveFont.pointSize, weight: isStrong ? .bold : .regular)
            } else {
                let weighted = isStrong
                    ? MessageFont.systemFont(ofSize: effectiveFont.pointSize, weight: .bold)
                    : effectiveFont
                font = isEmphasized
                    ? italic(weighted)
                    : weighted
            }
            attributed.addAttribute(.font, value: font, range: range)
            if isStrikethrough {
                attributed.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            }
        }
        return attributed
    }

    private static func heading(in line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let markerCount = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(markerCount),
              trimmed.dropFirst(markerCount).first == " " else { return nil }
        return (markerCount, String(trimmed.dropFirst(markerCount + 1)))
    }

    private static func unorderedListItem(in line: String) -> (depth: Int, text: String)? {
        matchListItem(in: line, regex: unorderedListItemRegex).map { ($0.depth, $0.text) }
    }

    private static func orderedListItem(in line: String) -> (depth: Int, ordinal: String, text: String)? {
        guard let match = orderedListItemRegex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let indentRange = Range(match.range(at: 1), in: line),
              let ordinalRange = Range(match.range(at: 2), in: line),
              let textRange = Range(match.range(at: 3), in: line) else { return nil }
        return (String(line[indentRange]).count / 2, String(line[ordinalRange]), String(line[textRange]))
    }

    private static func matchListItem(in line: String, regex: NSRegularExpression) -> (depth: Int, text: String)? {
        guard let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let indentRange = Range(match.range(at: 1), in: line),
              let textRange = Range(match.range(at: 2), in: line) else { return nil }
        return (String(line[indentRange]).count / 2, String(line[textRange]))
    }

    private static func blockQuote(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix(">") else { return nil }
        return String(trimmed.dropFirst().drop(while: { $0 == " " }))
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        return compact.count >= 3 && (Set(compact) == ["-"] || Set(compact) == ["*"] || Set(compact) == ["_"])
    }

    #if canImport(AppKit)
    private static let secondaryText = MessageColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    private static let codeBackground = MessageColor.quaternaryLabelColor
    private static let quoteColor = MessageColor.secondaryLabelColor
    private static let separatorColor = MessageColor.separatorColor
    private static func italic(_ font: MessageFont) -> MessageFont {
        NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
    }
    #else
    private static let secondaryText = MessageColor(red: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    private static let codeBackground = MessageColor.quaternaryLabel
    private static let quoteColor = MessageColor.secondaryLabel
    private static let separatorColor = MessageColor.separator
    private static func italic(_ font: MessageFont) -> MessageFont {
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(
            font.fontDescriptor.symbolicTraits.union(.traitItalic)) else { return font }
        return MessageFont(descriptor: descriptor, size: font.pointSize)
    }
    #endif
}
