// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CorptieClientCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "CorptieClientCore", targets: ["CorptieClientCore"]),
               .library(name: "CorptieClientSecurity", targets: ["CorptieClientSecurity"])],
    targets: [
        .target(name: "CorptieClientCore"),
        .target(name: "CorptieClientSecurity", dependencies: ["CorptieClientCore"]),
        .testTarget(name: "CorptieClientSecurityTests", dependencies: ["CorptieClientSecurity"]),
        .testTarget(name: "CorptieClientCoreTests", dependencies: ["CorptieClientCore"])
    ]
)
