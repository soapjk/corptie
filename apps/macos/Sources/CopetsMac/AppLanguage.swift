import Foundation
import SwiftUI

enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case english
    case simplifiedChinese

    var id: String { rawValue }

    var locale: Locale {
        switch self {
        case .system:
            .autoupdatingCurrent
        case .english:
            Locale(identifier: "en")
        case .simplifiedChinese:
            Locale(identifier: "zh-Hans")
        }
    }

    var localizationKey: String {
        switch self {
        case .system:
            "System Default"
        case .english:
            "English"
        case .simplifiedChinese:
            "Simplified Chinese"
        }
    }
}

@MainActor
final class AppLanguageController: ObservableObject {
    static let shared = AppLanguageController()

    @Published var selection: AppLanguage {
        didSet {
            CorptieAppEnvironment.userDefaults.set(selection.rawValue, forKey: storageKey)
        }
    }

    var locale: Locale { selection.locale }

    var localizationBundle: Bundle {
        let localization: String
        switch selection {
        case .system:
            localization = Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
                ? "zh-Hans"
                : "en"
        case .english:
            localization = "en"
        case .simplifiedChinese:
            localization = "zh-Hans"
        }
        guard let stringsPath = Bundle.module.path(
            forResource: "Localizable",
            ofType: "strings",
            inDirectory: nil,
            forLocalization: localization
        ),
              let bundle = Bundle(path: URL(fileURLWithPath: stringsPath).deletingLastPathComponent().path) else {
            return .module
        }
        return bundle
    }

    private let storageKey = "corptie.appLanguage"

    private init() {
        let stored = CorptieAppEnvironment.userDefaults.string(forKey: storageKey)
        selection = stored.flatMap(AppLanguage.init(rawValue:)) ?? .system
    }
}

@MainActor
func L10n(_ key: String) -> String {
    AppLanguageController.shared.localizationBundle.localizedString(
        forKey: key,
        value: key,
        table: nil
    )
}

@MainActor
func L10nFormat(_ key: String, _ arguments: CVarArg...) -> String {
    String(
        format: L10n(key),
        locale: AppLanguageController.shared.locale,
        arguments: arguments
    )
}
