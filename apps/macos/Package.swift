// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CorptieMac",
    defaultLocalization: "en",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CorptieMac", targets: ["CorptieMac"])
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
        .package(url: "https://github.com/tevelee/SwiftUI-Flow", exact: "3.1.1")
    ],
    targets: [
        .target(
            name: "RectanglePacking",
            path: "Sources/RectanglePacking",
            exclude: ["UPSTREAM.md", "vendor/Readme.txt"],
            publicHeadersPath: "include",
            // Keep the geometry kernel optimized in Development as well;
            // Swift UI code and diagnostics retain their normal build mode.
            cxxSettings: [.unsafeFlags(["-O2"])]
        ),
        .executableTarget(
            name: "CorptieMac",
            dependencies: [
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
                .process("Resources/en.lproj"),
                .process("Resources/zh-Hans.lproj")
            ],
            linkerSettings: [
                .linkedFramework("WebKit"),
                .linkedFramework("UserNotifications"),
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "CorptieMacTests",
            dependencies: ["CorptieMac"],
            path: "Tests/CopetsMacTests"
        )
    ],
    cxxLanguageStandard: .cxx11
)
