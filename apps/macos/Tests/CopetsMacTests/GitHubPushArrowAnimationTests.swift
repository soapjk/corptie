import Testing
@testable import CorptieMac

struct GitHubPushArrowAnimationTests {
    @Test func progressUsesAnArrowWithoutACircularBackground() {
        #expect(GitHubPushArrowAnimation.progressSymbolName == "arrow.up")
    }

    @Test func phaseRepeatsAtTheConfiguredDuration() {
        #expect(GitHubPushArrowAnimation.progress(at: 0) == 0)
        #expect(abs(GitHubPushArrowAnimation.progress(at: 0.45) - 0.5) < 0.000_001)
        #expect(abs(GitHubPushArrowAnimation.progress(at: 0.9)) < 0.000_001)
    }

    @Test func arrowTravelsUpWhileRemainingFullyOpaque() {
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 0) == 8)
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 0.5) == 0)
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 1) == -8)
        #expect(GitHubPushButtonAppearance.arrowOpacity == 1)
    }

    @Test func pushingShellMatchesTheNormalButtonGeometry() {
        #expect(GitHubPushButtonAppearance.width == 30)
        #expect(GitHubPushButtonAppearance.height == 28)
        #expect(GitHubPushButtonAppearance.cornerRadius == 8)
        #expect(GitHubPushButtonAppearance.backgroundOpacity == 0.13)
    }

    @Test func ignoredAgentDirectoryIsRemovedFromDisclosedPushFiles() {
        let disclosed = GitHubPushDisclosure.filesToPush(
            filesToPush: [".corptie/", "Feature.swift"],
            changedFiles: [".corptie/", "Feature.swift"],
            protectedPaths: [".corptie/toolset.json", ".corptie/restart.sh"],
            ignoringProtectedFiles: true
        )

        #expect(disclosed == [".gitignore", "Feature.swift"])
    }

    @Test func includedAgentFilesRemainInDisclosedPushFiles() {
        let disclosed = GitHubPushDisclosure.filesToPush(
            filesToPush: [".corptie/", "Feature.swift"],
            changedFiles: [".corptie/", "Feature.swift"],
            protectedPaths: [".corptie/toolset.json"],
            ignoringProtectedFiles: false
        )

        #expect(disclosed == [".corptie/", "Feature.swift"])
    }
}
