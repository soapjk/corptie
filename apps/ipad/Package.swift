// swift-tools-version: 6.0
import PackageDescription

// Host-runnable state tests; the iOS/iPadOS application is built with CorptieMobile.xcodeproj.
let package = Package(name: "CorptieMobileState", platforms: [.macOS(.v14), .iOS("27.0")],
    dependencies: [
        .package(path: "../../packages/CorptieClientCore"),
        .package(path: "../../packages/CorptieConversation")
    ],
    targets: [
        .target(name: "CorptieMobileState", dependencies: [
            .product(name: "CorptieClientCore", package: "CorptieClientCore"),
            .product(name: "CorptieClientSecurity", package: "CorptieClientCore"),
            .product(name: "CorptieConversation", package: "CorptieConversation")],
            path: "Sources", exclude: ["PadStandardTimeline.swift", "PadStandardTimelineFixture.swift", "PadNativeTimeline.swift", "CorptieMobileApp.swift", "CloudSignInSession.swift", "PadAppShell.swift", "PadControlView.swift", "PairingScannerView.swift", "PadKeyboardDismissal.swift", "PadComposerExtras.swift", "PadComposer.swift", "PadComposerTextView.swift", "PadThreadMetaView.swift", "PadMessageText.swift", "PadTaskCreationSheet.swift", "PadWorkAvatars.swift", "PadWorkOutline.swift", "PadMessageImages.swift", "PadMessageLayout.swift", "PadEntityMenus.swift"]),
        .testTarget(name: "CorptieMobileStateTests", dependencies: ["CorptieMobileState"], path: "Tests")
    ])
