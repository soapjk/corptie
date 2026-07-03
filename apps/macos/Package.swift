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
            resources: [
                .copy("Resources/AppIcon.png")
            ]
        )
    ]
)
