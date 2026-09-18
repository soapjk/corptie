import XCTest
@testable import CorptieMac

@MainActor
final class WorkspaceAccessStoreTests: XCTestCase {
    func testParentWorkspaceCoversDescendantsAndSurvivesStoreRecreation() throws {
        let suite = "com.corptie.tests.workspace-access.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = WorkspaceAccessStore(defaults: defaults, storageKey: "test")
        XCTAssertTrue(store.authorize(root))
        XCTAssertTrue(store.covers(root.appendingPathComponent("nested/file.txt")))

        let restored = WorkspaceAccessStore(defaults: defaults, storageKey: "test")
        restored.restore()
        XCTAssertTrue(restored.covers(root.appendingPathComponent("another-child")))
        XCTAssertEqual(restored.authorizedPaths, [root.standardizedFileURL.path])
    }

    func testParentAuthorizationReplacesRedundantChildBookmark() throws {
        let suite = "com.corptie.tests.workspace-access.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-\(UUID().uuidString)", isDirectory: true)
        let child = root.appendingPathComponent("child", isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = WorkspaceAccessStore(defaults: defaults, storageKey: "test")
        XCTAssertTrue(store.authorize(child))
        XCTAssertTrue(store.authorize(root))
        XCTAssertEqual(store.authorizedPaths, [root.standardizedFileURL.path])
    }
}
