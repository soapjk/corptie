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
