// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CorptieMac",
    defaultLocalization: "en",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CorptieMac", targets: ["CorptieMac"]),
        .executable(name: "CorptieComputerUse", targets: ["CorptieComputerUse"])
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1"),
        .package(path: "../../packages/CorptieClientCore"),
        .package(path: "../../packages/CorptieConversation"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
        .package(url: "https://github.com/tevelee/SwiftUI-Flow", exact: "3.1.1")
    ],
    targets: [
        .executableTarget(
            name: "CorptieComputerUse",
            path: "Sources/CorptieComputerUse",
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("ApplicationServices"), .linkedFramework("ScreenCaptureKit")]
        ),
        .testTarget(name: "CorptieComputerUseTests", dependencies: ["CorptieComputerUse"], path: "Tests/CorptieComputerUseTests"),
        .target(
            name: "RectanglePacking",
            path: "Sources/RectanglePacking",
            exclude: ["vendor/Readme.txt"],
            publicHeadersPath: "include",
            // Keep the geometry kernel optimized in Development as well;
            // Swift UI code and diagnostics retain their normal build mode.
            cxxSettings: [.unsafeFlags(["-O2"])]
        ),
        .executableTarget(
            name: "CorptieMac",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "CorptieClientCore", package: "CorptieClientCore"),
                .product(name: "CorptieClientSecurity", package: "CorptieClientCore"),
                .product(name: "CorptieConversation", package: "CorptieConversation"),
                "RectanglePacking",
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "Flow", package: "SwiftUI-Flow")
            ],
            path: "Sources/CopetsMac",
            exclude: [
                "Resources/AppIcon.icns",
                "Resources/AppIcon.iconset"
            ],
            resources: [
                .copy("Resources/AppIcon.png"),
                .copy("Resources/ProviderIcons"),
                .process("Resources/en.lproj"),
                .process("Resources/zh-Hans.lproj")
            ],
            linkerSettings: [
                .linkedFramework("WebKit"),
                .linkedFramework("UserNotifications"),
                .linkedLibrary("sqlite3")
            ]
        ),
        .executableTarget(
            name: "WorktreeDiagnosticInteractionHarness",
            dependencies: [.product(name: "CorptieConversation", package: "CorptieConversation")],
            path: "Tests/WorktreeDiagnosticInteractionHarness"
        ),
        .testTarget(
            name: "CorptieMacTests",
            dependencies: ["CorptieMac", "WorktreeDiagnosticInteractionHarness"],
            path: "Tests/CopetsMacTests"
        )
    ],
    cxxLanguageStandard: .cxx11
)
