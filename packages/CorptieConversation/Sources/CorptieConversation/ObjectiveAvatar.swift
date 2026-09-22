import Foundation
import SwiftUI

/// Deterministic gradient palette shared by every objective avatar (Work, Agent, Session).
/// Pure value maths: no platform image or colour types so both apps derive identical hues.
public struct DefaultAvatarGradientStyle: Equatable, Hashable, Sendable {
    public let familyHue: Int
    public let primaryHue: Int
    public let hueSpan: Int
    public let directionIndex: Int
    public let toneIndex: Int

    public static func make(seed: String) -> DefaultAvatarGradientStyle {
        make(familySeed: seed, variationSeed: seed)
    }

    public static func make(familySeed: String, variationSeed: String) -> DefaultAvatarGradientStyle {
        let familyHash = stableHash(normalizedSeed(familySeed))
        let variationHash = stableHash(normalizedSeed(variationSeed))
        let familyHue = Int(familyHash % 3_600)
        let variantIndex = Int(variationHash % UInt64(hueOffsets.count))
        let primaryHue = positiveModulo(familyHue + hueOffsets[variantIndex], 3_600)
        return DefaultAvatarGradientStyle(
            familyHue: familyHue,
            primaryHue: primaryHue,
            hueSpan: 360 + Int((familyHash >> 12) % 160),
            directionIndex: Int((variationHash >> 16) % UInt64(directions.count)),
            toneIndex: Int((variationHash >> 24) % UInt64(tones.count))
        )
    }

    public var gradient: LinearGradient {
        let middleHue = (primaryHue + hueSpan / 2) % 3_600
        let secondaryHue = (primaryHue + hueSpan) % 3_600
        let direction = Self.directions[directionIndex]
        let tone = Self.tones[toneIndex]
        return LinearGradient(
            colors: [
                Self.color(hue: primaryHue, saturation: tone.saturation - 0.04, brightness: tone.brightness + 0.08),
                Self.color(hue: middleHue, saturation: tone.saturation, brightness: tone.brightness),
                Self.color(hue: secondaryHue, saturation: tone.saturation + 0.04, brightness: tone.brightness - 0.10)
            ],
            startPoint: direction.start,
            endPoint: direction.end
        )
    }

    // Variants stay within a 54-degree workspace family, while adjacent slots
    // remain 18 degrees apart so sessions do not collapse into near-identical hues.
    private static let hueOffsets = [-270, -90, 90, 270]

    private static let tones: [(saturation: Double, brightness: Double)] = [
        (0.68, 0.84),
        (0.80, 0.78)
    ]

    private static let directions: [(start: UnitPoint, end: UnitPoint)] = [
        (.topLeading, .bottomTrailing),
        (.bottomLeading, .topTrailing),
        (.top, .bottom),
        (.leading, .trailing),
        (UnitPoint(x: 0.15, y: 0), UnitPoint(x: 0.85, y: 1)),
        (UnitPoint(x: 0, y: 0.75), UnitPoint(x: 1, y: 0.25))
    ]

    private static func normalizedSeed(_ seed: String) -> String {
        let normalized = seed
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .precomposedStringWithCanonicalMapping
        return normalized.isEmpty ? "defaultavatar" : normalized
    }

    private static func positiveModulo(_ value: Int, _ divisor: Int) -> Int {
        let remainder = value % divisor
        return remainder >= 0 ? remainder : remainder + divisor
    }

    private static func stableHash(_ seed: String) -> UInt64 {
        let hash = seed.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { hash, byte in
            (hash ^ UInt64(byte)) &* 1_099_511_628_211
        }
        var mixed = hash
        mixed ^= mixed >> 30
        mixed &*= 0xbf58_476d_1ce4_e5b9
        mixed ^= mixed >> 27
        mixed &*= 0x94d0_49bb_1331_11eb
        mixed ^= mixed >> 31
        return mixed
    }

    private static func color(hue: Int, saturation: Double, brightness: Double) -> Color {
        Color(hue: Double(hue) / 3_600, saturation: saturation, brightness: brightness)
    }
}

public enum DefaultAvatarInitials {
    public static func make(from value: String, fallback: String = "A") -> String {
        let words = value
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .filter { !$0.isEmpty }
        if words.count > 1 {
            let initials = words.prefix(2).compactMap(\.first)
            if !initials.isEmpty {
                return String(initials).uppercased()
            }
        }
        let compact = value
            .filter { $0.isLetter || $0.isNumber }
            .prefix(2)
        return compact.isEmpty ? fallback : String(compact).uppercased()
    }
}

public struct DefaultInitialAvatarView: View {
    public let familySeed: String
    public let variationSeed: String
    public let initials: String
    public let size: CGFloat

    public init(seed: String, initials: String, size: CGFloat) {
        self.init(familySeed: seed, variationSeed: seed, initials: initials, size: size)
    }

    public init(familySeed: String, variationSeed: String, initials: String, size: CGFloat) {
        self.familySeed = familySeed
        self.variationSeed = variationSeed
        self.initials = initials
        self.size = size
    }

    public var body: some View {
        ZStack {
            Circle()
                .fill(DefaultAvatarGradientStyle.make(familySeed: familySeed, variationSeed: variationSeed).gradient)
            Circle()
                .fill(RadialGradient(colors: [Color.white.opacity(0.26), Color.clear],
                                     center: .topLeading, startRadius: 0, endRadius: size * 0.78))
            Text(initials)
                .font(.system(size: max(8, size * 0.29), weight: .bold, design: .rounded))
                .foregroundStyle(Color.white)
                .shadow(color: Color.black.opacity(0.24), radius: 1, y: 1)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

public enum MacOSAppIconGeometry {
    public static let cornerRadiusRatio: CGFloat = 0.2237

    public static func cornerRadius(for size: CGFloat) -> CGFloat {
        max(0, size * cornerRadiusRatio)
    }
}

public struct MacOSAppIconShape: Shape {
    public init() {}
    public func path(in rect: CGRect) -> Path {
        RoundedRectangle(
            cornerRadius: MacOSAppIconGeometry.cornerRadius(for: min(rect.width, rect.height)),
            style: .continuous
        )
        .path(in: rect)
    }
}

public enum ObjectiveAvatarGeometry {
    public static let visualScale: CGFloat = 0.86

    public static func displaySize(for layoutSize: CGFloat) -> CGFloat {
        max(0, floor(layoutSize * visualScale))
    }
}

/// Objective (Work / Agent) avatar: identical gradient, initials, squircle and
/// 0.86 visual inset on every platform. Only the raster image leaf is injected,
/// because file paths (macOS) and gateway-fetched bytes (iPad) differ in origin.
public struct ObjectiveAvatarView<Picture: View>: View {
    public let objectiveID: String
    public let name: String
    public let size: CGFloat
    private let picture: Picture?

    /// `picture` is nil when the objective has no custom avatar; the shared
    /// gradient + initials fallback then renders identically on both platforms.
    public init(objectiveID: String, name: String, size: CGFloat, picture: Picture?) {
        self.objectiveID = objectiveID
        self.name = name
        self.size = size
        self.picture = picture
    }

    public var body: some View {
        let displaySize = ObjectiveAvatarGeometry.displaySize(for: size)
        ZStack {
            if let picture {
                picture
            } else {
                MacOSAppIconShape()
                    .fill(DefaultAvatarGradientStyle.make(familySeed: name, variationSeed: objectiveID).gradient)
                MacOSAppIconShape()
                    .fill(RadialGradient(colors: [Color.white.opacity(0.26), Color.clear],
                                         center: .topLeading, startRadius: 0, endRadius: displaySize * 0.78))
                Text(DefaultAvatarInitials.make(from: name, fallback: "?"))
                    .font(.system(size: max(8, displaySize * 0.29), weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                    .shadow(color: Color.black.opacity(0.24), radius: 1, y: 1)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(width: displaySize, height: displaySize)
        .clipShape(MacOSAppIconShape())
        .frame(width: size, height: size)
    }
}

extension ObjectiveAvatarView where Picture == EmptyView {
    public init(objectiveID: String, name: String, size: CGFloat) {
        self.init(objectiveID: objectiveID, name: name, size: size, picture: nil)
    }
}
