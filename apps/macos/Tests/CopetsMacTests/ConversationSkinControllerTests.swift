import XCTest
import Combine
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ConversationSkinControllerTests: XCTestCase {
    func testPreferencesPersistAndStayIsolatedWithoutDuplicateUpdates() throws {
        let name = "corptie.skin.tests.\(UUID().uuidString)"
        let otherName = name + ".other"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        let other = try XCTUnwrap(UserDefaults(suiteName: otherName))
        defer { defaults.removePersistentDomain(forName: name); other.removePersistentDomain(forName: otherName) }
        let controller = ConversationSkinController(defaults: defaults)
        XCTAssertEqual(controller.skin, .classic)
        var updates = 0
        let token = controller.$skin.dropFirst().sink { _ in updates += 1 }
        controller.select(.codexFlat)
        controller.select(.codexFlat)
        XCTAssertEqual(updates, 1)
        XCTAssertEqual(ConversationSkinController(defaults: defaults).skin, .codexFlat)
        XCTAssertEqual(ConversationSkinController(defaults: other).skin, .classic)
        controller.restoreDefault()
        XCTAssertEqual(ConversationSkinController(defaults: defaults).skin, .classic)
        withExtendedLifetime(token) {}
    }
    func testUnknownPreferenceFallsBackWithoutRewritingIt() throws {
        let name = "corptie.skin.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("future-skin", forKey: ConversationSkinController.preferenceKey)
        XCTAssertEqual(ConversationSkinController(defaults: defaults).skin, .classic)
        XCTAssertEqual(defaults.string(forKey: ConversationSkinController.preferenceKey), "future-skin")
    }
}
