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

    func testSharedNamePrefixesStayInTheSameColorFamily() {
        let corptie = DefaultAvatarGradientStyle.make(seed: "corptie_agent")
        let corptieChild = DefaultAvatarGradientStyle.make(seed: "corptie_agent_1")
        let marketcow = DefaultAvatarGradientStyle.make(seed: "marketcow_agent")
        let marketcowVisualization = DefaultAvatarGradientStyle.make(seed: "marketcow_visualization_agent")

        XCTAssertLessThanOrEqual(hueDistance(corptie.primaryHue, corptieChild.primaryHue), 8)
        XCTAssertLessThanOrEqual(hueDistance(marketcow.primaryHue, marketcowVisualization.primaryHue), 70)
        XCTAssertEqual(corptie.hueSpan, corptieChild.hueSpan)
        XCTAssertEqual(marketcow.directionIndex, marketcowVisualization.directionIndex)
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
