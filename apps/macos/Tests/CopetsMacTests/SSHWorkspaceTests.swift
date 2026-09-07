import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class SSHWorkspaceTests: XCTestCase {
    func testLocalWorkspaceDecodingKeepsExistingExecutionBehavior() throws {
        let workspace = try JSONDecoder().decode(WorkspaceResource.self, from: Data(#"{"workspaceId":"workspace:local","kind":"linkedLocal","ownership":"userManaged","rootPath":"/local","canonicalRootPath":"/local","status":"ready"}"#.utf8))
        XCTAssertNil(workspace.location)
        XCTAssertTrue(workspace.supportsWorkExecution)
    }

    func testRemoteConnectionDoesNotImplyVerifiedExecution() throws {
        let workspace = try JSONDecoder().decode(WorkspaceResource.self, from: Data(#"{"workspaceId":"workspace:ssh","kind":"sshRemote","ownership":"externalManaged","rootPath":"/remote/repo","canonicalRootPath":"/remote/repo","status":"pending","location":{"transport":"ssh","connectionId":"ssh:host","hostIdentity":"host:key","hostLabel":"Development","hostAlias":"dev","rootPath":"/remote/repo","identity":"ssh-workspace:one","connectionState":"connected","cwdIsSandbox":false,"executionSupported":false}}"#.utf8))
        XCTAssertFalse(workspace.supportsWorkExecution)
        XCTAssertEqual(workspace.location?.connectionState, "connected")
        XCTAssertEqual(workspace.location?.cwdIsSandbox, false)
        let roundtrip = try JSONDecoder().decode(WorkspaceResource.self, from: JSONEncoder().encode(workspace))
        XCTAssertEqual(roundtrip, workspace)
    }

    func testNativeConfigurationFormLayoutAndSnapshot() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: SSHWorkspaceSetupView(workspaceId: .constant(nil), client: OfflineSSHWorkspaceAPI())
            .background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 430), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        XCTAssertTrue(host.fittingSize.width.isFinite)
        XCTAssertLessThanOrEqual(host.fittingSize.width, 560)
        XCTAssertGreaterThan(host.fittingSize.height, 150)
        let started = ContinuousClock.now
        for _ in 0..<50 {
            host.needsLayout = true
            host.layoutSubtreeIfNeeded()
        }
        print("SSH native Form 50 layouts: \(started.duration(to: .now))")
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try data.write(to: URL(fileURLWithPath: "/tmp/corptie-ssh-workspace-ui.png"))
    }

    func testRemoteInventoryDecodingRetainsBranchAndUnknownDirectoryFlags() throws {
        let json = #"{"observation":{"rootPath":"/remote","observedAt":"2026-09-06T00:00:00Z","worktrees":[{"path":"/remote/task","headOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branchRef":"refs/heads/task","detached":false,"locked":true,"prunable":true}]}}"#
        let envelope = try JSONDecoder().decode(SSHWorkspaceObservationEnvelope.self, from: Data(json.utf8))
        let tree = try XCTUnwrap(envelope.observation?.worktrees.first)
        XCTAssertEqual(tree.branchRef, "refs/heads/task")
        XCTAssertTrue(tree.locked)
        XCTAssertTrue(tree.prunable)
    }
}

@MainActor
private struct OfflineSSHWorkspaceAPI: SSHWorkspaceAPI {
    func observation(workspaceId: String) async throws -> SSHWorkspaceObservationEnvelope { .init(observation: nil) }
    func probe(workspaceId: String) async throws -> SSHWorkspaceObservationEnvelope { throw CancellationError() }
    func listConnections() async throws -> SSHConnectionsEnvelope { .init(connections: [], aliases: []) }
    func inspectAlias(_ alias: String) async throws -> SSHHostInspection { throw CancellationError() }
    func registerConnection(alias: String, label: String, fingerprint: String) async throws -> SSHConnectionEnvelope { throw CancellationError() }
    func registerWorkspace(connectionId: String, rootPath: String) async throws -> WorkspaceRegistrationEnvelope { throw CancellationError() }
}
