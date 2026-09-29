import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
final class NativeTimelineTextView: NSTextView, NSTextViewDelegate {
    var linkBaseDirectory: String?
    var cardContextMenu: NSMenu?
    var onTextSelectionEnded: (() -> Void)?
    private(set) var usesNativeTextMenu = false
    var linkHandler: @MainActor (URL, String?) -> Bool = { url, baseDirectory in
        MessageLinkOpener.handle(url, baseDirectory: baseDirectory)
    }

    init() {
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let textContainer = NSTextContainer(containerSize: NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.lineFragmentPadding = 0
        textContainer.lineBreakMode = .byCharWrapping
        textContainer.widthTracksTextView = true
        textContainer.heightTracksTextView = false
        layoutManager.addTextContainer(textContainer)
        textStorage.addLayoutManager(layoutManager)
        super.init(frame: .zero, textContainer: textContainer)
        drawsBackground = false
        isEditable = false
        isSelectable = true
        isRichText = true
        delegate = self
        importsGraphics = false
        textContainerInset = .zero
        isHorizontallyResizable = false
        isVerticallyResizable = false
        maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        identifier = NSUserInterfaceItemIdentifier("chat.timeline.body")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        usesNativeTextMenu ? super.menu(for: event) : cardContextMenu
    }

    func beginTextSelection() {
        usesNativeTextMenu = true
        window?.makeFirstResponder(self)
    }

    func endTextSelection() {
        let wasUsingNativeTextMenu = usesNativeTextMenu
        usesNativeTextMenu = false
        setSelectedRange(NSRange(location: 0, length: 0))
        if wasUsingNativeTextMenu { onTextSelectionEnded?() }
    }

    override func cancelOperation(_ sender: Any?) {
        if usesNativeTextMenu {
            endTextSelection()
        } else {
            super.cancelOperation(sender)
        }
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        let url: URL?
        if let value = link as? URL {
            url = value
        } else if let value = link as? String {
            url = URL(string: value)
        } else {
            url = nil
        }
        guard let url else { return false }
        return linkHandler(url, linkBaseDirectory)
    }

    override func layout() {
        super.layout()
        guard let textContainer else { return }
        let expectedSize = NSSize(
            width: max(1, bounds.width),
            height: CGFloat.greatestFiniteMagnitude
        )
        if abs(textContainer.containerSize.width - expectedSize.width) >= 0.5
            || textContainer.containerSize.height != expectedSize.height {
            textContainer.containerSize = expectedSize
            layoutManager?.ensureLayout(for: textContainer)
        }
    }

    var laidOutCharacterRange: NSRange {
        guard let layoutManager, let textContainer else { return NSRange(location: 0, length: 0) }
        layoutManager.ensureLayout(for: textContainer)
        let glyphRange = layoutManager.glyphRange(for: textContainer)
        return layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
    }
}

@MainActor
final class NativeCollaborationRouteSummaryView: NSView {
    static let height: CGFloat = 92
    private var presentation: NativeCollaborationRoutePresentation?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func configure(_ presentation: NativeCollaborationRoutePresentation) {
        guard self.presentation != presentation else { return }
        self.presentation = presentation
        setAccessibilityElement(true)
        setAccessibilityLabel(
            "\(presentation.routeLabel)。\(presentation.sourceLabel)：\(presentation.sourceSession)，\(presentation.sourceWork)。\(presentation.targetLabel)：\(presentation.targetName)，\(presentation.targetWork)"
        )
        needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let presentation, bounds.width > 80 else { return }

        let accent: NSColor = presentation.destinationKind == .existingSession
            ? .systemBlue
            : .systemOrange
        let badgeFont = NSFont.systemFont(ofSize: 9, weight: .bold)
        let badgeText = presentation.routeLabel as NSString
        let badgeWidth = min(bounds.width, ceil(badgeText.size(withAttributes: [.font: badgeFont]).width) + 22)
        let badgeRect = NSRect(x: 0, y: 0, width: badgeWidth, height: 20)
        accent.withAlphaComponent(0.12).setFill()
        NSBezierPath(roundedRect: badgeRect, xRadius: 10, yRadius: 10).fill()
        badgeText.draw(
            in: badgeRect.insetBy(dx: 11, dy: 4),
            withAttributes: [.font: badgeFont, .foregroundColor: accent]
        )

        let panelY: CGFloat = 28
        let panelHeight: CGFloat = 64
        let arrowLane: CGFloat = 30
        let panelWidth = max(20, (bounds.width - arrowLane) / 2)
        let sourceRect = NSRect(x: 0, y: panelY, width: panelWidth, height: panelHeight)
        let targetRect = NSRect(x: panelWidth + arrowLane, y: panelY, width: panelWidth, height: panelHeight)
        drawPanel(
            sourceRect,
            caption: presentation.sourceLabel,
            primary: presentation.sourceSession,
            secondary: presentation.sourceWork,
            accent: .systemBlue
        )
        drawPanel(
            targetRect,
            caption: presentation.targetLabel,
            primary: presentation.targetName,
            secondary: presentation.targetWork,
            accent: accent
        )

        if let arrow = NSImage(systemSymbolName: "arrow.right", accessibilityDescription: nil) {
            let arrowRect = NSRect(
                x: panelWidth + 7,
                y: panelY + (panelHeight - 16) / 2,
                width: 16,
                height: 16
            )
            arrow.draw(in: arrowRect)
        }
    }

    private func drawPanel(
        _ rect: NSRect,
        caption: String,
        primary: String,
        secondary: String,
        accent: NSColor
    ) {
        NSColor.labelColor.withAlphaComponent(0.045).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9).fill()

        let content = rect.insetBy(dx: 9, dy: 7)
        drawTruncated(
            caption,
            in: NSRect(x: content.minX, y: content.minY, width: content.width, height: 12),
            font: .systemFont(ofSize: 8.5, weight: .bold),
            color: accent
        )
        drawTruncated(
            primary,
            in: NSRect(x: content.minX, y: content.minY + 17, width: content.width, height: 16),
            font: .systemFont(ofSize: 11, weight: .semibold),
            color: .labelColor
        )
        drawTruncated(
            secondary,
            in: NSRect(x: content.minX, y: content.minY + 36, width: content.width, height: 14),
            font: .systemFont(ofSize: 9.5, weight: .medium),
            color: .secondaryLabelColor
        )
    }

    private func drawTruncated(_ text: String, in rect: NSRect, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        (text as NSString).draw(
            in: rect,
            withAttributes: [
                .font: font,
                .foregroundColor: color,
                .paragraphStyle: paragraph
            ]
        )
    }
}
