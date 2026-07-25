import XCTest
@testable import CorptieMac

final class DefaultAvatarGradientTests: XCTestCase {
    func testSameSeedAlwaysProducesTheSameGradient() {
        XCTAssertEqual(
            DefaultAvatarGradientStyle.make(seed: "agent-123"),
            DefaultAvatarGradientStyle.make(seed: "agent-123")
        )
        XCTAssertEqual(
            DefaultAvatarGradientStyle.make(seed: " Agent-123 "),
            DefaultAvatarGradientStyle.make(seed: "agent-123")
        )
    }

    func testWorkspaceDefinesTheColorFamily() {
        let first = DefaultAvatarGradientStyle.make(
            familySeed: "/Volumes/T9/projects/corptie",
            variationSeed: "session-1"
        )
        let second = DefaultAvatarGradientStyle.make(
            familySeed: "/Volumes/T9/projects/corptie",
            variationSeed: "session-2"
        )
        let otherWorkspace = DefaultAvatarGradientStyle.make(
            familySeed: "/Volumes/T9/projects/marketcow",
            variationSeed: "session-1"
        )

        XCTAssertEqual(first.familyHue, second.familyHue)
        XCTAssertEqual(first.hueSpan, second.hueSpan)
        XCTAssertNotEqual(first.familyHue, otherWorkspace.familyHue)
    }

    func testSessionsInTheSameWorkspaceUseSeparatedVariants() {
        let first = DefaultAvatarGradientStyle.make(
            familySeed: "/Volumes/T9/projects/corptie",
            variationSeed: "session-1"
        )
        let second = DefaultAvatarGradientStyle.make(
            familySeed: "/Volumes/T9/projects/corptie",
            variationSeed: "session-2"
        )

        XCTAssertGreaterThanOrEqual(hueDistance(first.primaryHue, second.primaryHue), 180)
        XCTAssertLessThanOrEqual(hueDistance(first.primaryHue, first.familyHue), 270)
        XCTAssertLessThanOrEqual(hueDistance(second.primaryHue, second.familyHue), 270)
    }

    func testDifferentPrefixesStillProduceAUsefulRangeOfColors() {
        let hues = Set([
            "alpha", "bravo", "corptie", "delta", "echo", "foxtrot",
            "gemini", "helios", "indigo", "jupiter", "kilo", "lima"
        ].map { DefaultAvatarGradientStyle.make(seed: $0).primaryHue / 100 })
        XCTAssertGreaterThanOrEqual(hues.count, 8)
    }

    func testInitialsUseWordsAndSupportCompactNames() {
        XCTAssertEqual(DefaultAvatarInitials.make(from: "Corptie Agent"), "CA")
        XCTAssertEqual(DefaultAvatarInitials.make(from: "小明"), "小明")
        XCTAssertEqual(DefaultAvatarInitials.make(from: "---"), "A")
    }

    private func hueDistance(_ left: Int, _ right: Int) -> Int {
        let direct = abs(left - right)
        return min(direct, 3_600 - direct)
    }
}
