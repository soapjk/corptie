// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CopetsMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CopetsMac", targets: ["CopetsMac"])
    ],
    targets: [
        .executableTarget(
            name: "CopetsMac"
        )
    ]
)
