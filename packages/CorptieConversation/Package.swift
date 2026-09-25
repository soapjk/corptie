// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CorptieConversation",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "CorptieConversation", targets: ["CorptieConversation"])],
    dependencies: [.package(path: "../CorptieClientCore")],
    targets: [
        .target(name: "CorptieConversation", dependencies: [
            .product(name: "CorptieClientCore", package: "CorptieClientCore")]),
        .testTarget(name: "CorptieConversationTests", dependencies: ["CorptieConversation"])
    ]
)
