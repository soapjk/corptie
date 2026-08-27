import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class NativeMarkdownAttributedTextTests: XCTestCase {
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
            "Heading\n\n•  first\n•  second with bold\n\n1.  ordered\n2.  next\n\n│  quoted\n\nlet value = 42\nprint(value)\n"
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
