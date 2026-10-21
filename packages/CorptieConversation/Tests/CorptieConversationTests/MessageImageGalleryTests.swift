import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation

struct MessageImageGalleryTests {
    @Test func geometryCalculationRemainsBoundedForLongConversationReflows() {
        let geometries = [(600,900),(1600,900),(600,600),(100,10000)].map {
            MessageImageGeometry(pixelWidth: $0.0, pixelHeight: $0.1)
        }
        let start = Date()
        for index in 0..<10000 {
            let layout = MessageImageGalleryLayout.layout(geometries: geometries, width: 200 + Double(index % 140))
            #expect(layout.frames.count == 4)
        }
        #expect(Date().timeIntervalSince(start) < 3)
    }
    @Test func knownImagesHugTheirAspectRatioRatherThanFourByThree() throws {
        for (w, h) in [(1600,900),(900,1600),(600,600),(40,40),(10000,100),(100,10000)] {
            let geometry = try #require(MessageImageGeometry(pixelWidth: w, pixelHeight: h))
            for width in [96.0, 240.0, 340.0, 480.0] {
                let layout = MessageImageGalleryLayout.layout(geometries: [geometry], width: width)
                let rect = try #require(layout.frames.first)
                #expect(abs(rect.width / rect.height - Double(w) / Double(h)) < 0.00001)
                #expect(rect.width <= min(340, width) && rect.height <= 260)
                #expect(layout.size == rect.size)
                let card = MessageImageGalleryLayout.cardWidth(bodyWidth: 0, geometries: [geometry], laneWidth: width + 24)
                #expect(abs(card - max(40, rect.width + 20)) < 0.001)
            }
        }
    }

    @Test func multiImageFramesPreserveOrderRatioAndGroupBoundsWithoutRelayoutFeedback() throws {
        let values = [(900,1600),(1600,900),(600,600),(100,10000)].map {
            MessageImageGeometry(pixelWidth: $0.0, pixelHeight: $0.1)
        }
        for count in 1...8 {
            let geometries = (0..<count).map { values[$0 % values.count] }
            for lane in [120.0, 240.0, 375.0, 768.0] {
                let layout = MessageImageGalleryLayout.layout(geometries: geometries, width: lane - 24)
                let cardWidth = MessageImageGalleryLayout.cardWidth(bodyWidth: 0, geometries: geometries, laneWidth: lane)
                #expect(layout.frames.count == min(count, 4))
                #expect(layout.size.width + 20 <= cardWidth + 0.001)
                #expect(layout.size.height <= (count == 1 ? 260 : 300) + 0.001)
                for index in layout.frames.indices {
                    let image = try #require(geometries[index]), rect = layout.frames[index]
                    #expect(abs(rect.width / rect.height - Double(image.pixelWidth) / Double(image.pixelHeight)) < 0.00001)
                    for other in layout.frames.indices where other > index { #expect(!rect.intersects(layout.frames[other])) }
                }
            }
        }
    }

    @Test func unknownGeometryIsCompactAndCaptionCanWidenCardWithoutStretchingImage() throws {
        #expect(MessageImageGalleryLayout.layout(geometries: [nil], width: 340).size == CGSize(width: 88, height: 88))
        #expect(MessageImageGalleryLayout.cardWidth(bodyWidth: 0, geometries: [nil], laneWidth: 600) == 108)
        let geometry = try #require(MessageImageGeometry(pixelWidth: 900, pixelHeight: 1600))
        let size = MessageImageGalleryLayout.layout(geometries: [geometry], width: 340).size
        #expect(MessageImageGalleryLayout.cardWidth(bodyWidth: 450, geometries: [geometry], laneWidth: 600) == 470)
        #expect(size.width < 200 && size.height == 260)
    }
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
