import Foundation
import XCTest
@testable import CorptieMac

final class GitBranchResolverTests: XCTestCase {
    func testResolvesTheCurrentBranchInsideAGitRepository() throws {
        let repository = try makeRepository(branch: "feature/avatar-stamp")
        defer { try? FileManager.default.removeItem(at: repository) }
        try runGit(["commit", "--allow-empty", "-m", "initial"], at: repository)

        XCTAssertEqual(
            GitBranchResolver.headStateSynchronously(at: repository.path),
            .branch(
                name: "feature/avatar-stamp",
                oid: try gitOutput(["rev-parse", "HEAD"], at: repository)
            )
        )
    }

    func testReportsAnUnbornBranch() throws {
        let repository = try makeRepository(branch: "feature/unborn")
        defer { try? FileManager.default.removeItem(at: repository) }

        XCTAssertEqual(
            GitBranchResolver.headStateSynchronously(at: repository.path),
            .unborn(name: "feature/unborn")
        )
    }

    func testReportsDetachedHead() throws {
        let repository = try makeRepository(branch: "main")
        defer { try? FileManager.default.removeItem(at: repository) }
        try runGit(["commit", "--allow-empty", "-m", "initial"], at: repository)
        let oid = try gitOutput(["rev-parse", "HEAD"], at: repository)
        try runGit(["switch", "--detach", oid], at: repository)

        XCTAssertEqual(
            GitBranchResolver.headStateSynchronously(at: repository.path),
            .detached(oid: oid)
        )
    }

    func testReportsDirectoryOutsideAGitRepository() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-non-git-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertEqual(
            GitBranchResolver.headStateSynchronously(at: directory.path),
            .notRepository
        )
    }

    func testReportsMissingWorktree() {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-missing-\(UUID().uuidString)", isDirectory: true)
            .path

        XCTAssertEqual(
            GitBranchResolver.headStateSynchronously(at: path),
            .missingWorktree
        )
    }

    @MainActor
    func testCachedHeaderHeadIsPathScopedAndRefreshesAfterBranchChanges() async throws {
        let first = try makeRepository(branch: "first-header"), second = try makeRepository(branch: "second-header")
        defer { try? FileManager.default.removeItem(at: first); try? FileManager.default.removeItem(at: second) }
        try runGit(["commit", "--allow-empty", "-m", "initial"], at: first)
        XCTAssertNil(GitBranchResolver.cachedHeadState(at: first.path))
        let firstHead = await GitBranchResolver.headState(at: first.path)
        let secondHead = await GitBranchResolver.headState(at: second.path)
        XCTAssertEqual(GitBranchResolver.cachedHeadState(at: first.path + "/."), firstHead)
        XCTAssertEqual(GitBranchResolver.cachedHeadState(at: second.path), secondHead)
        XCTAssertNotEqual(firstHead, secondHead)
        try runGit(["switch", "-c", "updated-header"], at: first)
        XCTAssertEqual(GitBranchResolver.cachedHeadState(at: first.path), firstHead, "Keep the last display value while refreshing")
        let updated = await GitBranchResolver.headState(at: first.path)
        XCTAssertEqual(GitBranchResolver.cachedHeadState(at: first.path), updated)
        XCTAssertNotEqual(updated, firstHead)
        XCTAssertEqual(GitBranchResolver.cachedHeadState(at: second.path), secondHead)
        try FileManager.default.removeItem(at: first)
        let missing = await GitBranchResolver.headState(at: first.path)
        XCTAssertEqual(missing, .missingWorktree, "Authoritative failure must replace a cached branch")
        XCTAssertEqual(GitBranchResolver.cachedHeadState(at: first.path), .missingWorktree)
    }

    @MainActor
    func testHeaderLastStatusCannotBleedAcrossSessionWorkspaceOrServer() throws {
        let json = #"{"project":{"repositoryId":"repo","mainWorktreeId":"main","mainPath":"/repo","mainBranch":"main","pendingWorktreeCount":0,"worktrees":[]},"toolset":{"installed":true,"configured":true,"manifestConfigured":true,"compatible":true,"requiresUpdate":false,"mainPath":"/repo","toolsetPath":"/repo/tools","profiles":[],"selectedProfile":"default"},"service":{"state":"running","freshness":"current","healthy":true}}"#
        let status = try JSONDecoder().decode(ProjectWorktreeStatusResponse.self, from: Data(json.utf8))
        let snapshot = SessionConversationHeaderSurface.ProjectStatusSnapshot(serverID: "local", sessionID: "a", workspacePath: "/repo/a", status: status)
        XCTAssertEqual(snapshot.value(serverID: "local", sessionID: "a", workspacePath: "/repo/a"), status)
        XCTAssertNil(snapshot.value(serverID: "local", sessionID: "b", workspacePath: "/repo/a"))
        XCTAssertNil(snapshot.value(serverID: "local", sessionID: "a", workspacePath: "/repo/b"))
        XCTAssertNil(snapshot.value(serverID: "other-server", sessionID: "a", workspacePath: "/repo/a"))
    }

    private func makeRepository(branch: String) throws -> URL {
        let repository = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-git-branch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        try runGit(["init", "-b", branch], at: repository)
        return repository
    }

    private func runGit(_ arguments: [String], at directory: URL) throws {
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", directory.path] + arguments
        process.environment = gitEnvironment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errors
        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let data = errors.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8) ?? "git failed"
            XCTFail(message)
        }
    }

    private func gitOutput(_ arguments: [String], at directory: URL) throws -> String {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", directory.path] + arguments
        process.environment = gitEnvironment
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = errors.fileHandleForReading.readDataToEndOfFile()
            throw NSError(
                domain: "GitBranchResolverTests",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "git failed"]
            )
        }
        return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var gitEnvironment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_AUTHOR_NAME"] = "Corptie Tests"
        environment["GIT_AUTHOR_EMAIL"] = "tests@corptie.local"
        environment["GIT_COMMITTER_NAME"] = "Corptie Tests"
        environment["GIT_COMMITTER_EMAIL"] = "tests@corptie.local"
        return environment
    }
}
