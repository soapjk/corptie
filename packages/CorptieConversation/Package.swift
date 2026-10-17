// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CorptieConversation",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "CorptieConversation", targets: ["CorptieConversation"])],
    dependencies: [
        .package(path: "../CorptieClientCore"),
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.6.0"),
        .package(url: "https://github.com/mgriebling/SwiftMath.git", exact: "1.7.3")
    ],
    targets: [
        .target(name: "CorptieConversation", dependencies: [
            .product(name: "CorptieClientCore", package: "CorptieClientCore"),
            .product(name: "Markdown", package: "swift-markdown"),
            .product(name: "SwiftMath", package: "SwiftMath")
        ], resources: [.copy("Resources/DetailWeb")]),
        .testTarget(name: "CorptieConversationTests", dependencies: ["CorptieConversation"])
    ]
)
