import Foundation
import Testing
@testable import CorptieClientCore

struct MessageImageGeometryTests {
    @Test func orientationAndInvalidHintsAreNormalized() {
        for orientation in 1...8 {
            let value = MessageImageGeometry(pixelWidth: 600, pixelHeight: 900, orientation: orientation)
            #expect(value?.pixelWidth == (orientation >= 5 ? 900 : 600))
        }
        for (w, h) in [(0,1),(-1,600),(1_000_001,1),(1_000_000,1_000_000)] {
            #expect(MessageImageGeometry(pixelWidth: w, pixelHeight: h) == nil)
        }
        #expect(MessageImageGeometry(pixelWidth: nil, pixelHeight: 10) == nil)
    }
    @Test func olderAttachmentDTOsStillDecodeAndNewHintsAreOptional() throws {
        let old = try JSONDecoder().decode(ClientMessageImage.self, from: Data(#"{"managedPath":"chat-resources/a.png"}"#.utf8))
        #expect(old.geometry == nil)
        let new = try JSONDecoder().decode(ClientMessageImage.self, from: Data(#"{"managedPath":"chat-resources/a.png","pixelWidth":200,"pixelHeight":600}"#.utf8))
        #expect(new.geometry == MessageImageGeometry(pixelWidth: 200, pixelHeight: 600))
    }
}
