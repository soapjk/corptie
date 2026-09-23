// swift-tools-version: 6.0
import PackageDescription

// Host-runnable state tests; the iOS/iPadOS application is built with CorptieMobile.xcodeproj.
let package = Package(name: "CorptieMobileState", platforms: [.macOS(.v14), .iOS(.v17)],
    dependencies: [.package(path: "../../packages/CorptieClientCore")],
    targets: [
        .target(name: "CorptieMobileState", dependencies: [
            .product(name: "CorptieClientCore", package: "CorptieClientCore"),
            .product(name: "CorptieClientSecurity", package: "CorptieClientCore")],
            path: "Sources", exclude: ["CorptieMobileApp.swift", "PadAppShell.swift", "PadControlView.swift", "PairingScannerView.swift", "PadKeyboardDismissal.swift", "PadComposerExtras.swift", "PadComposer.swift", "PadComposerTextView.swift", "PadThreadMetaView.swift", "PadMessageText.swift", "PadTaskCreationSheet.swift", "PadWorkAvatars.swift", "PadWorkOutline.swift", "PadMessageImages.swift", "PadMessageLayout.swift", "PadEntityMenus.swift"]),
        .testTarget(name: "CorptieMobileStateTests", dependencies: ["CorptieMobileState"], path: "Tests")
    ])
