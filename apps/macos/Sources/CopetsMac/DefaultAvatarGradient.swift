import Foundation
import SwiftUI

struct DefaultAvatarGradientStyle: Equatable, Hashable {
    let primaryHue: Int
    let hueSpan: Int
    let directionIndex: Int

    static func make(seed: String) -> DefaultAvatarGradientStyle {
        let normalized = normalizedSeed(seed)
        let coordinate = prefixCoordinate(normalized)
        let prefixHash = stableHash(String(normalized.prefix(4)))
        return DefaultAvatarGradientStyle(
            primaryHue: Int((coordinate * 3_600).rounded()) % 3_600,
            hueSpan: 520 + Int(prefixHash % 420),
            directionIndex: Int((prefixHash >> 12) % UInt64(directions.count))
        )
    }

    var gradient: LinearGradient {
        let middleHue = (primaryHue + hueSpan / 2) % 3_600
        let secondaryHue = (primaryHue + hueSpan) % 3_600
        let direction = Self.directions[directionIndex]
        return LinearGradient(
            colors: [
                Self.color(hue: primaryHue, saturation: 0.68, brightness: 0.94),
                Self.color(hue: middleHue, saturation: 0.72, brightness: 0.86),
                Self.color(hue: secondaryHue, saturation: 0.76, brightness: 0.76)
            ],
            startPoint: direction.start,
            endPoint: direction.end
        )
    }

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
            .filter { $0.isLetter || $0.isNumber }
        return normalized.isEmpty ? "defaultavatar" : normalized
    }

    private static func prefixCoordinate(_ seed: String) -> Double {
        var coordinate = 0.0
        var weight = 0.5
        for scalar in seed.unicodeScalars.prefix(18) {
            let mixed = UInt64(scalar.value) &* 11_400_714_819_323_198_485 &+ 7_046_029_254_386_353_131
            let unitValue = Double((mixed ^ (mixed >> 29)) % 10_000) / 10_000
            coordinate += unitValue * weight
            weight *= 0.5
        }
        return coordinate.truncatingRemainder(dividingBy: 1)
    }

    private static func stableHash(_ seed: String) -> UInt64 {
        seed.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { hash, byte in
            (hash ^ UInt64(byte)) &* 1_099_511_628_211
        }
    }

    private static func color(hue: Int, saturation: Double, brightness: Double) -> Color {
        Color(
            hue: Double(hue) / 3_600,
            saturation: saturation,
            brightness: brightness
        )
    }
}

struct DefaultInitialAvatarView: View {
    let seed: String
    let initials: String
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(DefaultAvatarGradientStyle.make(seed: seed).gradient)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color.white.opacity(0.26), Color.clear],
                        center: .topLeading,
                        startRadius: 0,
                        endRadius: size * 0.78
                    )
                )
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

enum DefaultAvatarInitials {
    static func make(from value: String, fallback: String = "A") -> String {
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
