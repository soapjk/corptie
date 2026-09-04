import Foundation
import XCTest
@testable import CorptieMac

final class MessageLinkResolverTests: XCTestCase {
    func testResolvesAbsoluteFileAndStripsExistingLineAndColumnSuffix() throws {
        try withTemporaryDirectory { directory in
            let file = directory.appendingPathComponent("Source.swift")
            try Data("let value = 1".utf8).write(to: file)
            let rawURL = try XCTUnwrap(URL(string: file.path + ":42:7"))

            let target = try XCTUnwrap(try? MessageLinkResolver.resolve(
                rawURL,
                baseDirectory: directory.path
            ).get())

            XCTAssertEqual(target.kind, .file)
            XCTAssertEqual(target.url, file.standardizedFileURL)
        }
    }

    func testResolvesPercentEncodedSpacesAndChineseCharacters() throws {
        try withTemporaryDirectory { directory in
            let file = directory.appendingPathComponent("中文 file.swift")
            try Data("content".utf8).write(to: file)
            let encodedPath = try XCTUnwrap(file.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed))
            let rawURL = try XCTUnwrap(URL(string: encodedPath))

            let target = try XCTUnwrap(try? MessageLinkResolver.resolve(
                rawURL,
                baseDirectory: directory.path
            ).get())

            XCTAssertEqual(target.kind, .file)
            XCTAssertEqual(target.url, file.standardizedFileURL)
        }
    }

    func testResolvesRelativeFileAgainstSessionWorkspace() throws {
        try withTemporaryDirectory { directory in
            let sources = directory.appendingPathComponent("Sources", isDirectory: true)
            try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
            let file = sources.appendingPathComponent("Feature.swift")
            try Data().write(to: file)

            let target = try XCTUnwrap(try? MessageLinkResolver.resolve(
                try XCTUnwrap(URL(string: "Sources/Feature.swift:12")),
                baseDirectory: directory.path
            ).get())

            XCTAssertEqual(target.url, file.standardizedFileURL)
        }
    }

    func testRejectsRelativeFileWithoutWorkspace() throws {
        let result = MessageLinkResolver.resolve(
            try XCTUnwrap(URL(string: "Sources/Feature.swift")),
            baseDirectory: nil
        )

        guard case .failure(.missingBaseDirectory("Sources/Feature.swift")) = result else {
            return XCTFail("Expected a missing-base-directory failure, received \(result)")
        }
    }

    func testReportsMissingFileInsteadOfReturningAnOpenableTarget() throws {
        try withTemporaryDirectory { directory in
            let missing = directory.appendingPathComponent("missing.swift")
            let result = MessageLinkResolver.resolve(
                try XCTUnwrap(URL(string: missing.path)),
                baseDirectory: directory.path
            )

            guard case .failure(.missingFile(let path)) = result else {
                return XCTFail("Expected a missing-file failure, received \(result)")
            }
            XCTAssertEqual(path, missing.standardizedFileURL.path)
        }
    }

    func testClassifiesDirectoriesAndExecutableTargetsSafely() throws {
        try withTemporaryDirectory { directory in
            let folder = directory.appendingPathComponent("Documentation", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let command = directory.appendingPathComponent("build.command")
            try Data("#!/bin/sh".utf8).write(to: command)

            let folderTarget = try XCTUnwrap(try? MessageLinkResolver.resolve(
                folder,
                baseDirectory: directory.path
            ).get())
            let commandTarget = try XCTUnwrap(try? MessageLinkResolver.resolve(
                command,
                baseDirectory: directory.path
            ).get())

            XCTAssertEqual(folderTarget.kind, .directory)
            XCTAssertEqual(commandTarget.kind, .revealOnly)
        }
    }

    func testResolvesFilesOutsideTheSessionWorkspaceWithoutASeparatePolicyGate() throws {
        try withTemporaryDirectory { root in
            let workspace = root.appendingPathComponent("workspace", isDirectory: true)
            let outside = root.appendingPathComponent("outside.txt")
            try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
            try Data().write(to: outside)
            let symlink = workspace.appendingPathComponent("linked-outside.txt")
            try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)

            let target = try XCTUnwrap(try? MessageLinkResolver.resolve(
                outside,
                baseDirectory: workspace.path
            ).get())
            let traversalTarget = try XCTUnwrap(try? MessageLinkResolver.resolve(
                try XCTUnwrap(URL(string: "../outside.txt")),
                baseDirectory: workspace.path
            ).get())
            let symlinkTarget = try XCTUnwrap(try? MessageLinkResolver.resolve(
                symlink,
                baseDirectory: workspace.path
            ).get())

            XCTAssertEqual(target.url, outside.standardizedFileURL)
            XCTAssertEqual(traversalTarget.url, outside.standardizedFileURL)
            XCTAssertEqual(symlinkTarget.url, outside.standardizedFileURL)
        }
    }

    func testPreservesWebURLAndRejectsUnknownOrRemoteFileSchemes() throws {
        let webURL = try XCTUnwrap(URL(string: "https://example.com/docs?q=swift#links"))
        let webTarget = try XCTUnwrap(try? MessageLinkResolver.resolve(
            webURL,
            baseDirectory: "/tmp"
        ).get())

        XCTAssertEqual(webTarget.kind, .web)
        XCTAssertEqual(webTarget.url, webURL)

        let customResult = MessageLinkResolver.resolve(
            try XCTUnwrap(URL(string: "javascript:alert(1)")),
            baseDirectory: "/tmp"
        )
        guard case .failure(.unsupportedScheme("javascript")) = customResult else {
            return XCTFail("Expected an unsupported-scheme failure, received \(customResult)")
        }

        let remoteFileResult = MessageLinkResolver.resolve(
            try XCTUnwrap(URL(string: "file://remote-host/tmp/file.swift")),
            baseDirectory: "/tmp"
        )
        guard case .failure(.remoteFileHost("remote-host")) = remoteFileResult else {
            return XCTFail("Expected a remote-file-host failure, received \(remoteFileResult)")
        }
    }

    func testExtractsLocalAndRemoteMarkdownImagesOutsideCodeFences() throws {
        try withTemporaryDirectory { directory in
            let image = directory.appendingPathComponent("preview image.png")
            try Data([0x89, 0x50, 0x4E, 0x47]).write(to: image)
            let markdown = """
            ![local](<preview image.png> "Preview")
            ![remote](https://example.com/preview.png)
            ![duplicate](https://example.com/preview.png)
            ```markdown
            ![example](https://example.com/not-rendered.png)
            ```
            """

            let references = MessageMarkdownImageResolver.references(
                in: markdown,
                baseDirectory: directory.path
            )

            XCTAssertEqual(references.map(\.url), [
                image.standardizedFileURL,
                try XCTUnwrap(URL(string: "https://example.com/preview.png"))
            ])
        }
    }

    func testMarkdownImageResolverIgnoresMissingFilesAndNonImageLinks() throws {
        try withTemporaryDirectory { directory in
            let references = MessageMarkdownImageResolver.references(
                in: "[document](https://example.com/doc) ![missing](missing.png)",
                baseDirectory: directory.path
            )

            XCTAssertTrue(references.isEmpty)
        }
    }

    private func withTemporaryDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-message-link-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }
}
