// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CorptieMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CorptieMac", targets: ["CorptieMac"])
    ],
    targets: [
        .executableTarget(
            name: "CorptieMac",
            path: "Sources/CopetsMac",
            exclude: [
                "Resources/AppIcon.icns",
                "Resources/AppIcon.iconset"
            ],
            resources: [
                .copy("Resources/AppIcon.png")
            ]
        )
    ]
)
