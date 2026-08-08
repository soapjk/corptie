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

    @Test func arrowTravelsUpAndFadesAtBothEdges() {
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 0) == 8)
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 0.5) == 0)
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 1) == -8)
        #expect(GitHubPushArrowAnimation.opacity(progress: 0) == 0)
        #expect(abs(GitHubPushArrowAnimation.opacity(progress: 0.5) - 1) < 0.000_001)
        #expect(abs(GitHubPushArrowAnimation.opacity(progress: 1)) < 0.000_001)
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
