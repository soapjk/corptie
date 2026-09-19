// swift-tools-version: 6.0
import PackageDescription

// Host-runnable state tests; the iPad application is built with CorptiePad.xcodeproj.
let package = Package(name: "CorptiePadState", platforms: [.macOS(.v14), .iOS(.v17)],
    dependencies: [.package(path: "../../packages/CorptieClientCore")],
    targets: [
        .target(name: "CorptiePadState", dependencies: [
            .product(name: "CorptieClientCore", package: "CorptieClientCore"),
            .product(name: "CorptieClientSecurity", package: "CorptieClientCore")],
            path: "Sources", exclude: ["CorptiePadApp.swift", "PadAppShell.swift", "PadControlView.swift", "PairingScannerView.swift", "PadKeyboardDismissal.swift", "PadComposerExtras.swift"]),
        .testTarget(name: "CorptiePadStateTests", dependencies: ["CorptiePadState"], path: "Tests")
    ])
