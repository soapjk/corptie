import XCTest
import SwiftUI
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ChatBubbleWidthPolicyTests: XCTestCase {
    func testNaturalWidthMatchesRenderedTextWithoutSpareCharacterOrOrphanLine() throws {
        let samples = ["开始开发", "开始开发。", "（开始开发）", "好的，谢谢！", "Please continue.",
            "Mixed 中文 **bold** punctuation!", "Emoji 👩🏽‍💻 works", "مرحبا بالعالم",
            "第一行较长的正文\n短句", "A longer first line\nSecond line.",
            "> 一段引用。", "- 第一项\n- 第二个项目", "# Heading\n正文。"]
        for typography in [ConversationTypography.classic, .codexReading] {
            for style in [AppKitChatTimelineRow.NativeStyle.user, .agent] {
                for text in samples {
                    let attributed = NativeMarkdownTextCache.shared.value(text: text, style: style, typography: typography)
                    let natural = try renderedGeometry(attributed, width: 4096)
                    let cardWidth = ChatBubbleWidthPolicy.preferredWidth(text: text, style: style,
                        title: "", metadata: "", typography: typography)
                    let bodyWidth = cardWidth - ChatBubbleWidthPolicy.horizontalPadding
                    let actual = try renderedGeometry(attributed, width: bodyWidth)
                    let context = "\(typography)/\(style): \(text)"
                    XCTAssertEqual(actual.lines, natural.lines, "No new orphan line: \(context)")
                    XCTAssertEqual(actual.height, natural.height, accuracy: 0.01, context)
                    XCTAssertGreaterThanOrEqual(bodyWidth + 0.01, actual.width, context)
                    if natural.width > ChatBubbleWidthPolicy.minimumWidth - ChatBubbleWidthPolicy.horizontalPadding {
                        XCTAssertLessThan(bodyWidth - natural.width, 1.01, "Only rounding slack: \(context)")
                    }
                }
            }
        }
    }

    func testClampedUserWidthStillWrapsAtNativeTextBoundaries() throws {
        for typography in [ConversationTypography.classic, .codexReading] {
            for text in [String(repeating: "Mixed 中文 punctuation，", count: 30), String(repeating: "x", count: 300)] {
                for width: CGFloat in [180, 320, 900] {
                    let cardWidth = ChatBubbleWidthPolicy.preferredWidth(text: text, style: .user,
                        title: "", metadata: "", availableWidth: width, typography: typography)
                    let attributed = NativeMarkdownTextCache.shared.value(text: text, style: .user, typography: typography)
                    let actual = try renderedGeometry(attributed, width: cardWidth - ChatBubbleWidthPolicy.horizontalPadding)
                    XCTAssertEqual(cardWidth, min(width, ChatBubbleWidthPolicy.maximumWidth))
                    XCTAssertGreaterThan(actual.lines, 1)
                    XCTAssertLessThanOrEqual(actual.width, cardWidth - ChatBubbleWidthPolicy.horizontalPadding + 0.01)
                }
            }
        }
    }

    func testHostedShortUserBubbleKeepsTightBodyAcrossResizeWithoutReplacingText() throws {
        _ = NSApplication.shared
        func textView(in view: NSView) -> NativeTimelineTextView? {
            (view as? NativeTimelineTextView) ?? view.subviews.lazy.compactMap { textView(in: $0) }.first
        }
        for skin in ConversationSkin.allCases {
            for text in ["开始开发", "开始开发。", "Please continue.", "First line\n第二行。"] {
                let row = AppKitChatTimelineRow(id: "tight-user", contentRevision: 1,
                    nativeText: text, copyText: text, nativeStyle: .user, title: "", metadata: "",
                    expandableTurnId: nil, isExpanded: false, showsHeader: false)
                let cell = AppKitSharedMessageTextCell(identifier: .init("tight-user"))
                let window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: 900, height: 200),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = cell
                defer { window.contentView = nil; window.close() }
                cell.updateAppearance(skin: skin)
                cell.setContent(row, availableWidth: 900, onToggleExpansion: { _ in })
                cell.layoutSubtreeIfNeeded()
                let body = try XCTUnwrap(textView(in: cell))
                let attributed = try XCTUnwrap(body.textStorage)
                let natural = try renderedGeometry(attributed, width: 4096)
                let configurations = cell.contentConfigurationCount, updates = cell.hostUpdateCount
                body.setSelectedRange(.init(location: 1, length: 2))
                for width: CGFloat in [900, 320, 600, 321, 900] {
                    cell.setFrameSize(.init(width: width, height: 200))
                    XCTAssertTrue(cell.updateLayoutIfContentUnchanged(row, availableWidth: width))
                    cell.layoutSubtreeIfNeeded()
                    XCTAssertTrue(textView(in: cell) === body)
                    let container = try XCTUnwrap(body.textContainer), manager = try XCTUnwrap(body.layoutManager)
                    manager.ensureLayout(for: container)
                    let used = manager.usedRect(for: container)
                    XCTAssertEqual(used.height, natural.height, accuracy: 0.01)
                    XCTAssertGreaterThanOrEqual(body.bounds.width + 0.01, used.width)
                    XCTAssertLessThan(body.bounds.width - natural.width, 1.01, "\(skin): \(text)")
                    XCTAssertEqual(body.selectedRange(), NSRange(location: 1, length: 2))
                    XCTAssertEqual(cell.contentConfigurationCount, configurations)
                    XCTAssertEqual(cell.hostUpdateCount, updates)
                }
                print("TIGHT_BUBBLE \(skin) \(text.debugDescription): body=\(body.bounds.width), used=\(natural.width)")
            }
        }
    }

    private func renderedGeometry(_ text: NSAttributedString, width: CGFloat) throws -> (width: CGFloat, height: CGFloat, lines: Int) {
        let view = NativeTimelineTextView()
        view.textStorage?.setAttributedString(text)
        let container = try XCTUnwrap(view.textContainer), manager = try XCTUnwrap(view.layoutManager)
        container.widthTracksTextView = false
        container.containerSize = .init(width: width, height: .greatestFiniteMagnitude)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        var lines = 0
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, _, _, _, _ in lines += 1 }
        XCTAssertEqual(manager.characterRange(forGlyphRange: manager.glyphRange(for: container), actualGlyphRange: nil).length,
            text.length, "The full message must be laid out")
        return (used.width, used.height, lines)
    }

    func testIntrinsicContentRestoresClassicTypographyAndAttributedContent() {
        let text = "模型回复 English **bold**\n\n" + String(repeating: "Wrapped 中文 text ", count: 40)
        let row = AppKitChatTimelineRow(id: "reading-cache", contentRevision: 1, nativeText: text,
            copyText: text, nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        for width: CGFloat in [320, 900] {
            let classic = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: width, skin: .classic)
            let reading = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: width, skin: .codexFlat)
            XCTAssertEqual((classic.attributedText.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 11)
            XCTAssertEqual((reading.attributedText.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 14)
            let restored = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: width, skin: .classic)
            XCTAssertTrue(restored.attributedText.isEqual(to: classic.attributedText))
            XCTAssertEqual(restored.cardWidth, classic.cardWidth)
        }
    }

    func testAssistantRepliesUseTheSafeLaneInBothIntrinsicSkins() {
        let long = String(repeating: "Model response content ", count: 100)
        for text in [long, "```swift\nprint(\"Hello\")\n```", "| A | B |\n|---|---|\n| one | two |"] {
            let row = AppKitChatTimelineRow(id: "wide-reply-\(text)", contentRevision: 1,
                nativeText: text, copyText: text, nativeStyle: .agent, title: "", metadata: "",
                expandableTurnId: nil, isExpanded: false, showsHeader: false)
            for lane: CGFloat in [2400, 1600, 1000, 600, 320] {
                for skin in ConversationSkin.allCases {
                    let layout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: lane, skin: skin)
                    XCTAssertEqual(layout.cardWidth, lane - (skin == .classic ? 14 : 4))
                }
            }
        }
        XCTAssertLessThan(ChatBubbleWidthPolicy.preferredWidth(text: "Hi", style: .agent,
            title: "", metadata: ""), 60)
        XCTAssertEqual(preferredWidth(text: long, availableWidth: 1000), 640)
    }

    func testShortUserMessageHugsBodyInsteadOfMaximumWidth() {
        let width = preferredWidth(text: "Hi")

        XCTAssertGreaterThanOrEqual(width, ChatBubbleWidthPolicy.minimumWidth)
        XCTAssertLessThanOrEqual(width, 48)
        XCTAssertLessThan(width, 220)
        XCTAssertLessThan(width, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testWidthGrowsWithContentAndLongTextClampsAtMaximum() {
        let short = preferredWidth(text: "Hi")
        let medium = preferredWidth(text: "Please review the latest implementation and test results.")
        let long = preferredWidth(text: String(repeating: "long message content ", count: 80))

        XCTAssertGreaterThan(medium, short)
        XCTAssertEqual(long, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testRichMarkdownUsesFullSafeLane() {
        let width = preferredWidth(text: """
        ```swift
        print("Hi")
        ```
        """)

        XCTAssertEqual(width, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testCollapsedAndExpandedProcessWidthsAreExplicit() {
        let collapsed = preferredWidth(
            text: "Hi",
            processWidth: ChatBubbleWidthPolicy.collapsedProcessWidth
        )
        let expanded = preferredWidth(
            text: "Hi",
            processWidth: ChatBubbleWidthPolicy.maximumWidth - ChatBubbleWidthPolicy.horizontalPadding
        )

        XCTAssertEqual(
            collapsed,
            ChatBubbleWidthPolicy.collapsedProcessWidth + ChatBubbleWidthPolicy.horizontalPadding
        )
        XCTAssertEqual(expanded, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testNarrowViewportClampsPreferredWidth() {
        let width = preferredWidth(
            text: String(repeating: "wide content ", count: 40),
            availableWidth: 312
        )

        XCTAssertEqual(width, 312)
    }

    func testExpandedProcessCardRetainsItsOwnWidthCeiling() {
        XCTAssertEqual(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80, expanded: true, laneWidth: 900),
            MessageBubbleWidthPolicy.maximumProcessWidth)
        XCTAssertEqual(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80, expanded: true, laneWidth: 320), 316)

        let process = AppKitChatTimelineRow(
            id: "expanded-process", contentRevision: 1, nativeText: "Step details",
            copyText: "Step details", nativeStyle: .process, title: "", metadata: "",
            expandableTurnId: "turn", isExpanded: true, processCount: 1
        )
        XCTAssertEqual(LegacyTimelineLayoutReference.shared.layout(
            for: process, columnWidth: 900).cardWidth, MessageBubbleWidthPolicy.maximumProcessWidth)
    }

    /// User messages retain the shared default clamp and attachment floor.
    func testSharedPolicyMatchesDesktopClampAndAttachmentFloor() {
        XCTAssertEqual(ChatBubbleWidthPolicy.maximumWidth, MessageBubbleWidthPolicy.maximumWidth)
        XCTAssertEqual(ChatBubbleWidthPolicy.minimumWidth, MessageBubbleWidthPolicy.minimumWidth)
        XCTAssertEqual(ChatBubbleWidthPolicy.horizontalPadding, MessageBubbleWidthPolicy.horizontalPadding)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 12), MessageBubbleWidthPolicy.minimumWidth)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 100), 120)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 900), MessageBubbleWidthPolicy.maximumWidth)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 900, availableWidth: 312), 312)
        XCTAssertEqual(MessageBubbleWidthPolicy.cardWidth(bodyWidth: 20, hasAttachments: false, laneWidth: 600), 40)
        XCTAssertEqual(MessageBubbleWidthPolicy.cardWidth(bodyWidth: 20, hasAttachments: true, laneWidth: 600), 220)
        XCTAssertEqual(MessageBubbleWidthPolicy.cardWidth(bodyWidth: 20, hasAttachments: true, laneWidth: 200), 196)
        XCTAssertTrue(MessageBubbleWidthPolicy.requiresFullWidthLayout("| A | B |\n|---|---|"))
        XCTAssertFalse(MessageBubbleWidthPolicy.requiresFullWidthLayout("plain **bold** text"))
    }

    func testResizeRetainsNaturalWidthPreparationAndInvalidatesContentFontAndHeader() throws {
        for text in ["Plain **formatted** response", "```swift\nprint(1)\n```"] {
            var row = AppKitChatTimelineRow(id: "width-preparation", contentRevision: 1,
                nativeText: text, copyText: text, nativeStyle: .agent, title: "Assistant", metadata: "Now",
                expandableTurnId: nil, isExpanded: false, showsHeader: false)
            var layout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 900, skin: .classic)
            let original = try XCTUnwrap(layout.naturalWidthMetrics)
            for width: CGFloat in [800, 620, 320, 950] {
                layout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: width,
                    skin: .classic, reusing: layout)
                XCTAssertTrue(layout.naturalWidthMetrics === original)
                let fresh = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: width, skin: .classic)
                XCTAssertEqual(layout.cardWidth, fresh.cardWidth)
            }
            let reading = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 950,
                skin: .codexFlat, reusing: layout)
            XCTAssertFalse(reading.naturalWidthMetrics === original)
            let renamed = AppKitChatTimelineRow(id: row.id, contentRevision: row.contentRevision,
                nativeText: text, copyText: text, nativeStyle: .agent, title: "A different heading", metadata: "Now",
                expandableTurnId: nil, isExpanded: false, showsHeader: true)
            let header = NativeTimelineLayoutCache.shared.intrinsicContent(for: renamed, columnWidth: 950,
                skin: .classic, reusing: layout)
            XCTAssertFalse(header.naturalWidthMetrics === original)
            row.contentRevision += 1
            row.nativeText += " changed"
            let changed = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 950,
                skin: .classic, reusing: layout)
            XCTAssertFalse(changed.naturalWidthMetrics === original)
        }
    }

    private func preferredWidth(
        text: String,
        processWidth: CGFloat = 0,
        availableWidth: CGFloat = ChatBubbleWidthPolicy.maximumWidth
    ) -> CGFloat {
        ChatBubbleWidthPolicy.preferredWidth(
            text: text,
            style: .user,
            title: "",
            metadata: "",
            processWidth: processWidth,
            availableWidth: availableWidth
        )
    }
}
