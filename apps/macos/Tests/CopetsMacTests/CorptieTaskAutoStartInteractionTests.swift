import Foundation
import Testing

struct CorptieTaskAutoStartInteractionTests {
    @Test
    func creationAlwaysStartsACompanionWorkSession() throws {
        let source = try source(named: "CorptieTaskCreateView.swift")

        #expect(!source.contains("case createOnly"))
        #expect(!source.contains("仅创建不执行"))
        #expect(source.contains("Button(L10n(\"创建\"))"))
        #expect(source.contains("let providerId = selectedProviderId"))
        #expect(source.contains("await client.createSession("))
        #expect(source.contains("backendClient.acceptCreatedSession(session, selectImmediately: false)"))
        let sessionStart = try #require(source.range(of: "await client.createSession("))
        let createdCallback = try #require(source.range(
            of: "onCreated(startedTask)",
            range: sessionStart.lowerBound..<source.endIndex
        ))
        #expect(createdCallback.lowerBound > sessionStart.lowerBound)
    }

    @Test
    func taskInformationDoesNotExposeAManualStartButton() throws {
        let source = try source(named: "WarRoomView.swift")
        let controlStart = try #require(source.range(of: "private var executionControlButton: some View"))
        let controlEnd = try #require(source.range(
            of: "// 开始执行：",
            range: controlStart.lowerBound..<source.endIndex
        ))
        let control = source[controlStart.lowerBound..<controlEnd.lowerBound]

        #expect(!control.contains("play.fill"))
        #expect(!control.contains("currentSession == nil ? \"Run\""))
    }

    private func source(named name: String) throws -> String {
        let testsURL = URL(fileURLWithPath: #filePath)
        let packageRoot = testsURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CopetsMac/\(name)"),
            encoding: .utf8
        )
    }
}
