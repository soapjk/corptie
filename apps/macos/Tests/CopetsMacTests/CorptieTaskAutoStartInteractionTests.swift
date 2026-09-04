import Foundation
import Testing

struct CorptieTaskAutoStartInteractionTests {
    @Test
    func creationAlwaysStartsACompanionWorkSession() throws {
        let viewSource = try source(named: "CorptieTaskCreateView.swift")
        let clientSource = try source(named: "EntityAPIClient.swift")

        #expect(!viewSource.contains("case createOnly"))
        #expect(!viewSource.contains("仅创建不执行"))
        #expect(viewSource.contains("Button(L10n(\"创建\"))"))
        #expect(viewSource.contains("let providerId = selectedProviderId"))
        #expect(viewSource.contains("await client.createCorptieTask("))
        #expect(viewSource.contains("providerId: providerId"))
        #expect(!viewSource.contains("await client.createSession("))
        #expect(clientSource.contains("as: CorptieTaskCreateResponse.self"))
        #expect(clientSource.contains("acceptCreatedSession(created.session, selectImmediately: false)"))
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

    @Test
    func openingTaskInformationNeverRepairsDomainStateFromAViewLifecycleCallback() throws {
        let source = try source(named: "WarRoomView.swift")

        #expect(!source.contains("ensureCompanionSessionIfNeeded"))
        #expect(!source.contains("guard !isCompleted, currentSession == nil, !isLaunchingExecution"))
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
