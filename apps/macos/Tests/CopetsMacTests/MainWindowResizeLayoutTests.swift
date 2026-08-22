import SwiftUI
import Testing
@testable import CorptieMac

struct MainWindowResizeLayoutTests {
    @Test
    func onlySelectedPageReceivesAnimatedResizeProposals() {
        var cache = MainTabPageProposalCache(pageCount: AppTab.allCases.count)
        let initialSize = CGSize(width: 1_200, height: 700)
        for pageIndex in AppTab.allCases.indices {
            #expect(cache.proposal(
                for: pageIndex,
                selectedIndex: AppTab.console.index,
                containerSize: initialSize
            ) == initialSize)
        }

        let animatedSizes = stride(from: 1_220, through: 1_920, by: 20).map {
            CGSize(width: $0, height: 1_080)
        }
        for size in animatedSizes {
            for pageIndex in AppTab.allCases.indices {
                _ = cache.proposal(
                    for: pageIndex,
                    selectedIndex: AppTab.console.index,
                    containerSize: size
                )
            }
        }

        #expect(cache.pageSizes[AppTab.console.index] == animatedSizes.last)
        for tab in AppTab.allCases where tab != .console {
            #expect(cache.pageSizes[tab.index] == initialSize)
        }

        let selectedAtFullScreen = cache.proposal(
            for: AppTab.sessions.index,
            selectedIndex: AppTab.sessions.index,
            containerSize: animatedSizes.last!
        )
        #expect(selectedAtFullScreen == animatedSizes.last)
    }

    @Test
    func mainTabLayoutContractKeepsEveryPageResidentWithoutGeometryReader() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("MainTabPageLayout(selectedIndex: router.selectedTab.index)"))
        #expect(contents.contains("ForEach(AppTab.allCases)"))
        #expect(!contents.contains("GeometryReader { geo in"))
        #expect(!contents.contains(".frame(width: geo.size.width, height: geo.size.height)"))
    }

    @Test
    func splitViewColumnLimitsDoNotChangeForEveryAnimatedWindowWidth() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")

        for fileName in ["WarRoomView.swift", "SessionsView.swift"] {
            let contents = try String(
                contentsOf: sourceRoot.appendingPathComponent(fileName),
                encoding: .utf8
            )
            #expect(contents.contains("max: TwoPaneLayoutMetrics.sidebarMaximumWidth"))
            #expect(!contents.contains("w * 0.34"))
        }
    }
}
