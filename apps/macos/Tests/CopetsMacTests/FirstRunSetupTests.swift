import Foundation
import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

struct FirstRunSetupTests {
    @Test
    func discoveryAloneDoesNotUnlockSetup() throws {
        let status = try decode(enabled: false, executable: true)
        #expect(!status.canContinue)
    }

    @Test
    func testedExecutableUnlocksSetup() throws {
        #expect(try decode(enabled: true, executable: true).canContinue)
        #expect(try !decode(enabled: true, executable: false).canContinue)
    }

    @Test
    func failedOrRunningCheckCannotUnlockSetup() throws {
        #expect(try !decode(enabled: true, executable: true, checkState: "failed").canContinue)
        #expect(try !decode(enabled: true, executable: true, checkState: "checking").canContinue)
    }

    @Test
    func startupWaitsForConfigurationStatusAndRespectsCompletion() throws {
        #expect(FirstRunStatus.requiresSetup(nil))
        #expect(FirstRunStatus.requiresSetup(try decode(enabled: false, executable: false)))
        let completed = try JSONDecoder().decode(FirstRunStatus.self, from: Data(
            "{\"providers\":[],\"completed\":true,\"hasWorks\":false}".utf8))
        #expect(!FirstRunStatus.requiresSetup(completed))
    }

    private func decode(enabled: Bool, executable: Bool, checkState: String = "available") throws -> FirstRunStatus {
        let data = Data("""
        {"providers":[{"id":"provider","name":"Provider","path":"/tmp/provider","executable":\(executable),"enabled":\(enabled),"checkState":"\(checkState)"}],"completed":false,"hasWorks":false}
        """.utf8)
        return try JSONDecoder().decode(FirstRunStatus.self, from: data)
    }

    @Test @MainActor
    func configurationPageRendersAtCompactAndWideSizes() throws {
        let status = FirstRunStatus(providers: [
            FirstRunProvider(id: "codex-app-server", name: "Codex", path: "/tmp/codex", executable: true,
                             enabled: true, checkState: "available", message: nil),
            FirstRunProvider(id: "claude-sdk", name: "Claude Code", path: "", executable: false,
                             enabled: false, checkState: "missing", message: nil),
            FirstRunProvider(id: "openclacky", name: "OpenClacky", path: "", executable: false,
                             enabled: false, checkState: "missing", message: nil)
        ], completed: false, hasWorks: false, defaultProviderId: "codex-app-server",
           assistantSessionId: nil, workSessionId: nil)
        for (width, appearance) in [(CGFloat(560), NSAppearance.Name.aqua), (CGFloat(960), .darkAqua)] {
            let view = NSHostingView(rootView: FirstRunSetupRoot(initialStatus: status) { EmptyView() })
            view.appearance = NSAppearance(named: appearance)
            view.frame = NSRect(x: 0, y: 0, width: width, height: 820)
            view.layoutSubtreeIfNeeded()
            let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            #expect(bitmap.pixelsWide >= Int(width))
            #expect(bitmap.pixelsHigh >= 820)
            if let directory = ProcessInfo.processInfo.environment["CORPTIE_UI_EVIDENCE_DIR"] {
                let url = URL(fileURLWithPath: directory, isDirectory: true)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try bitmap.representation(using: .png, properties: [:])?.write(
                    to: url.appendingPathComponent("first-run-\(Int(width)).png"))
            }
        }
    }
}
