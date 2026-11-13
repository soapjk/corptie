import SwiftUI

// Shared conversation appearance for native window hosts.
struct IsLiquidGlassEnvironmentKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var isLiquidGlass: Bool {
        get { self[IsLiquidGlassEnvironmentKey.self] }
        set { self[IsLiquidGlassEnvironmentKey.self] = newValue }
    }
}

