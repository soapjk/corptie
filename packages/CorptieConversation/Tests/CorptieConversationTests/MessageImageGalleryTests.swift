import Foundation
import Testing
@testable import CorptieConversation

struct MessageImageGalleryTests {
    @Test func gallerySlotsAreBoundedNonoverlappingAndDeterministic() {
        for width: CGFloat in [20, 220, 320.5, 480, 900] {
            for count in 0...8 {
                let frames = MessageImageGalleryLayout.frames(count: count, width: width)
                #expect(frames.count == min(count, 4))
                #expect(frames == MessageImageGalleryLayout.frames(count: count, width: width))
                #expect(frames.allSatisfy { $0.width > 0 && $0.height > 0 && $0.minX >= 0 && $0.minY >= 0 && $0.maxX <= min(340, width) + 0.001 })
                for index in frames.indices {
                    for other in frames.indices where other > index { #expect(!frames[index].intersects(frames[other])) }
                }
                #expect(MessageImageGalleryLayout.height(count: count, width: width) == (frames.map(\.maxY).max() ?? 0))
            }
        }
    }

    @Test func imageReferencesPreserveTextAndIgnoreCodeFences() {
        let text = "Caption\n![screenshot](</tmp/a b.png> \"title\")\n[Download](https://example.com/chart.png)\n```swift\n![example](/tmp/no.png)\n```\n[report](/tmp/report.pdf)"
        let references = ConversationMessageImageReference.parse(text)
        #expect(references.map(\.source) == ["/tmp/a b.png", "https://example.com/chart.png"])
        let body = ConversationMessageImageReference.removing(references, from: text)
        #expect(body.contains("Caption"))
        #expect(body.contains("![example](/tmp/no.png)"))
        #expect(body.contains("[report](/tmp/report.pdf)"))
        #expect(!body.contains("[Download]"))
    }

    @Test func unsafeURLsRemainTextAndImagePlaceholdersNeedRealAttachments() {
        #expect(ConversationMessageImageReference.parse("![x](javascript:evil) ![y](data:image/png;base64,AA)").isEmpty)
        #expect(MessageImageGalleryLayout.bodyText("[localImage]\nhello", hasImages: false) == "[localImage]\nhello")
        #expect(MessageImageGalleryLayout.bodyText("[localImage]\nhello", hasImages: true) == "hello")
        #expect(MessageImageGalleryLayout.bodyText("I wrote [image] here", hasImages: true) == "I wrote [image] here")
    }

    @Test @MainActor func referenceCacheTracksBodyRevisionsIncludingLongHistory() {
        let prefix = String(repeating: "history\n", count: 10_000)
        let first = prefix + "![x](/tmp/a.png)"
        let next = prefix + "![x](/tmp/b.png)"
        let cache = ConversationMessageImageReferenceCache.shared
        #expect(cache.references(messageID: "cache-test", text: first).first?.source == "/tmp/a.png")
        #expect(cache.references(messageID: "cache-test", text: next).first?.source == "/tmp/b.png")
    }
}
