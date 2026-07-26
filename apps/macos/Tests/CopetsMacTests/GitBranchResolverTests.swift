import Foundation
import XCTest
@testable import CorptieMac

final class GitBranchResolverTests: XCTestCase {
    func testResolvesTheCurrentBranchInsideAGitRepository() throws {
        let repository = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-git-branch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repository) }

        try runGit(["init", "-b", "feature/avatar-stamp"], at: repository)

        XCTAssertEqual(
            GitBranchResolver.branchNameSynchronously(at: repository.path),
            "feature/avatar-stamp"
        )
    }

    func testReturnsNilOutsideAGitRepository() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-non-git-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertNil(GitBranchResolver.branchNameSynchronously(at: directory.path))
    }

    private func runGit(_ arguments: [String], at directory: URL) throws {
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", directory.path] + arguments
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
}
