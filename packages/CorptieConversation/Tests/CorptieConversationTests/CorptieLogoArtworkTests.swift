import CoreGraphics
import QuartzCore
import Testing
@testable import CorptieConversation

struct CorptieLogoArtworkTests {
    @Test @MainActor
    func repeatedConfigurationKeepsPathsAndOnlyTwoRotationAnimations() throws {
        let artwork = CorptieLogoArtworkLayer()
        let groups = try #require(artwork.sublayers)
        #expect(groups.count == 2)
        #expect(artwork.backgroundColor == nil)
        let outer = try #require(groups.first)
        let inner = try #require(groups.last)
        let arcs = try #require(outer.sublayers?.first as? CAShapeLayer)
        let path = try #require(arcs.path)
        let neutral = CGColor(gray: 0.9, alpha: 1)
        for _ in 0..<100 {
            artwork.setNeutralColor(neutral)
            artwork.setAnimating(true)
        }
        #expect(outer.sublayers?.first === arcs)
        #expect(arcs.path === path)
        #expect(outer.animationKeys() == ["rotation"])
        #expect(inner.animationKeys() == ["rotation"])
        let clockwise = try #require(outer.animation(forKey: "rotation") as? CABasicAnimation)
        let counterclockwise = try #require(inner.animation(forKey: "rotation") as? CABasicAnimation)
        #expect(abs(clockwise.duration - 60 / 31.5) < 0.0001)
        #expect(abs(counterclockwise.duration - 60 / 25.5) < 0.0001)
        #expect((clockwise.toValue as? Double) == 2 * Double.pi)
        #expect((counterclockwise.toValue as? Double) == -2 * Double.pi)
        artwork.setAnimating(false)
        #expect(outer.animationKeys()?.isEmpty != false)
        #expect(inner.animationKeys()?.isEmpty != false)
    }
}
