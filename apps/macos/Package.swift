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
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1")
    ],
    targets: [
        .executableTarget(
            name: "CorptieMac",
            dependencies: [
                .product(name: "MarkdownUI", package: "swift-markdown-ui")
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
            ]
        )
    ]
)
