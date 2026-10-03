import SwiftUI
import Testing
@testable import CorptieConversation

struct CollaborationHandshakeIconTests {
    @Test func vectorFitsExistingIconBoundsAtBothPlatformSizes() {
        for size in [12.0, 18.0, 24.0] {
            let rect = CGRect(x: 0, y: 0, width: size, height: size)
            let path = CollaborationHandshakeShape().path(in: rect)
            #expect(!path.isEmpty)
            #expect(rect.contains(path.boundingRect))
        }
    }
}
