import Testing
@testable import CorptieMac

struct GitHubPushArrowAnimationTests {
    @Test func progressUsesAnArrowWithoutACircularBackground() {
        #expect(GitHubPushArrowAnimation.progressSymbolName == "arrow.up")
    }

    @Test func phaseRepeatsAtTheConfiguredDuration() {
        #expect(GitHubPushArrowAnimation.progress(at: 0) == 0)
        #expect(abs(GitHubPushArrowAnimation.progress(at: 0.55) - 0.5) < 0.000_001)
        #expect(abs(GitHubPushArrowAnimation.progress(at: 1.1)) < 0.000_001)
    }

    @Test func arrowTravelsCompletelyThroughTheCircularButton() {
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 0) == 22)
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 0.5) == 0)
        #expect(GitHubPushArrowAnimation.verticalOffset(progress: 1) == -22)
        #expect(GitHubPushButtonAppearance.arrowOpacity == 1)
    }

    @Test func arrowFadesInFromBelowAndOutAtTheTopBeforeLooping() {
        #expect(GitHubPushArrowAnimation.opacity(progress: 0) == 0)
        #expect(abs(GitHubPushArrowAnimation.opacity(progress: 0.125) - 0.5) < 0.000_001)
        #expect(GitHubPushArrowAnimation.opacity(progress: 0.4) == 1)
        #expect(abs(GitHubPushArrowAnimation.opacity(progress: 0.775) - 0.5) < 0.000_001)
        #expect(GitHubPushArrowAnimation.opacity(progress: 1) == 0)
    }

    @Test func pushButtonUsesFixedCircularGeometryWithoutAnInnerSolidCircle() {
        #expect(GitHubPushButtonAppearance.diameter == 30)
        #expect(GitHubPushButtonAppearance.arrowFontSize == 12)
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

    @Test func pushChangesRemainSeparatedByOperation() {
        let groups = GitHubPushDisclosure.changeGroups(
            addedFiles: ["Added.swift"],
            modifiedFiles: ["Modified.swift"],
            deletedFiles: ["Deleted.swift"],
            changedFiles: ["Added.swift", "Modified.swift", "Deleted.swift"],
            protectedPaths: [],
            ignoringProtectedFiles: false
        )

        #expect(groups.added == ["Added.swift"])
        #expect(groups.modified == ["Modified.swift"])
        #expect(groups.deleted == ["Deleted.swift"])
    }

    @Test func ignoredAgentFilesAreRemovedFromTheirChangeGroup() {
        let groups = GitHubPushDisclosure.changeGroups(
            addedFiles: [".corptie/toolset.json", "Feature.swift"],
            modifiedFiles: [],
            deletedFiles: [],
            changedFiles: [".corptie/toolset.json", "Feature.swift"],
            protectedPaths: [".corptie/toolset.json"],
            ignoringProtectedFiles: true
        )

        #expect(groups.added == ["Feature.swift"])
        #expect(groups.modified == [".gitignore"])
        #expect(groups.deleted.isEmpty)
    }
}
