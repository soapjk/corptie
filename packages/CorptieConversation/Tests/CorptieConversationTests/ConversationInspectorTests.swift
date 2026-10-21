import Testing
import Foundation
import CorptieClientCore
import SwiftUI
#if os(macOS)
import AppKit
#endif
@testable import CorptieConversation

struct ConversationInspectorTests {
    @Test func chatHeadersReuseListAlarmAndCurrentTaskProjection() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let desktop = try String(contentsOf: root.appendingPathComponent(
            "apps/macos/Sources/CopetsMac/Conversation/ConversationHeader.swift"), encoding: .utf8)
        let mobile = try String(contentsOf: root.appendingPathComponent(
            "apps/ipad/Sources/CorptieMobileApp.swift"), encoding: .utf8)
        #expect(desktop.contains("guard let taskID = backendClient.selectedSession?.taskId else { return false }"))
        #expect(desktop.contains("entityClient.tasks.first(where: { $0.id == taskID })?.hasPendingScheduledWake == true"))
        #expect(desktop.contains("if hasPendingScheduledWake {"))
        #expect(desktop.contains("ConsoleScheduledWakeIcon(isActive: scenePhase == .active)"))
        #expect(mobile.contains("let task = workspace.tasks.first(where: { $0.id == session?.taskId })"))
        #expect(mobile.contains("if task?.hasPendingScheduledWake == true {"))
        #expect(mobile.contains("ScheduledWakeIcon(isActive: scenePhase == .active)"))
        for source in [desktop, mobile] {
            #expect(source.contains(".accessibilityIdentifier(\"conversation-task-scheduled-wake\")"))
            #expect(!source.contains("Image(systemName: \"alarm\")"), "Use the list component, not a duplicate glyph")
        }
        #expect(desktop.contains("copySessionTitle(selectedTitle)"))
        #expect(mobile.contains("UIPasteboard.general.string = title"))
    }

    @Test func worktreePreferenceUsesSharedNativeToggleWithoutAutoRebaseInViewCode() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ConversationWorktreeCard.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("Toggle(localize(tree.hierarchy == nil ? \"自动同步主分支\" : \"自动跟随父分支\")"))
        #expect(source.contains("detail?.autoFollow?.enabled == true"))
        #expect(source.contains("if !tree.isMain, tree.hierarchy?.role != \"parent\", detail?.autoFollow != nil"))
        #expect(source.contains("setAutoFollow(sessionID: sessionID, worktreeID: worktreeID, enabled: enabled)"))
        #expect(!source.contains("automaticFollow: "))
    }

    @Test func taskInformationDefaultsToSummaryWithOneBottomDisclosure() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ConversationTaskInformationCard.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let card = try #require(source.components(separatedBy: "public struct ConversationTaskInformationCard").last)
            .components(separatedBy: "/// A single native button")[0]
        #expect(card.contains("@State private var isExpanded = false"))
        let summary = try #require(card.range(of: "ConversationTaskSummaryView(summary:"))
        let expanded = try #require(card.range(of: "if isExpanded {"))
        let definition = try #require(card.range(of: "ConversationTaskDefinition(description:"))
        let preference = try #require(card.range(of: "Toggle(autoTitleLabel"))
        let disclosure = try #require(card.range(of: "Button { isExpanded.toggle() }"))
        #expect(summary.lowerBound < expanded.lowerBound)
        #expect(expanded.lowerBound < definition.lowerBound)
        #expect(definition.lowerBound < preference.lowerBound)
        #expect(preference.lowerBound < disclosure.lowerBound)
        #expect(card.contains(".accessibilityLabel(isExpanded ? collapseLabel : expandLabel)"))
    }

    #if os(macOS)
    @Test @MainActor func collapsedTaskInformationDoesNotLayOutLongDefinitions() {
        for width in [240.0, 280.0, 375.0] {
            func height(description: String, acceptance: String) -> CGFloat {
                let host = NSHostingView(rootView: ConversationTaskInformationCard(
                    summary: nil, description: description, acceptance: acceptance,
                    autoTitleEnabled: true, onAutoTitleChange: { _ in }) { EmptyView() }
                    .frame(width: width))
                host.frame = NSRect(x: 0, y: 0, width: width, height: 400)
                host.layoutSubtreeIfNeeded()
                return host.fittingSize.height
            }
            let short = height(description: "Short", acceptance: "Pass")
            let long = height(description: String(repeating: "Long task description\n", count: 100),
                              acceptance: String(repeating: "Acceptance criterion\n", count: 100))
            #expect(abs(short - long) < 1)
            #expect(long < 180)
        }
    }

    @Test @MainActor func worktreeCardRendersCompactWithoutDoingGitWorkInBody() throws {
        let detail = try JSONDecoder().decode(ClientSessionWorktreeDetail.self, from: Data(#"{"attached":true,"repositoryId":"repo","mainWorktreeId":"main","mainBranch":"develop","worktree":{"worktreeId":"tree","path":"/repo/feature","branchName":"feature","isMain":false,"availability":"available","dirty":false,"changedFiles":[],"aheadOfMain":3,"behindMain":2,"conflictFiles":[]}}"#.utf8))
        for width in [240.0, 280.0, 375.0] {
            let host = NSHostingView(rootView: ConversationWorktreeCard(sessionID: "test", refreshID: "test",
                api: { throw ClientConnectionError.invalidResponse }, initialDetail: detail).frame(width: width))
            host.frame = NSRect(x: 0, y: 0, width: width, height: 400)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height > 80)
            #expect(host.fittingSize.height < 250)
        }
    }
    #endif
    @Test func oneDeclaredChoiceSubmitsDirectlyButCompositeFormsDoNot() throws {
        func request(_ questions: String) throws -> ConversationUserInput {
            let json = """
            {"schemaVersion":1,"isBlocking":true,"questions":\(questions)}
            """
            return try JSONDecoder().decode(ConversationUserInput.self, from: Data(json.utf8))
        }
        let single = """
        [{"id":"route","header":"","question":"Route?","isOther":false,"isSecret":false,
          "options":[{"label":"A","description":"Fast"}]}]
        """
        #expect(ConversationUserInputInteractionPolicy.directSelectionQuestionID(try request(single)) == "route")
        let multiple = single.replacingOccurrences(of: "\"isOther\":false", with: "\"selectionMode\":\"multiple\",\"isOther\":false")
        #expect(ConversationUserInputInteractionPolicy.directSelectionQuestionID(try request(multiple)) == nil)
        let twoQuestions = String(single.dropLast()) + "," + String(single.dropFirst())
        #expect(ConversationUserInputInteractionPolicy.directSelectionQuestionID(try request(twoQuestions)) == nil)
    }

    @Test func customAnswerRemainsVisibleBesideAllDeclaredOptions() throws {
        let json = """
        {"schemaVersion":1,"isBlocking":true,"questions":[
          {"id":"route","header":"","question":"Route?","isOther":true,"isSecret":true,
           "options":[{"label":"A","description":"Fast"},{"label":"B","description":"Safe"}]}
        ],"submittedAnswers":{"route":["B","My own route"]}}
        """
        let request = try JSONDecoder().decode(ConversationUserInput.self, from: Data(json.utf8))
        #expect(ConversationInputAnswerPresentation.textAnswers(
            for: request.questions[0], submittedAnswers: request.submittedAnswers) == ["My own route"])
    }

    @Test func textOverflowUsesTheSameToleranceOnBothPlatforms() {
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 60.4, collapsedHeight: 60))
        #expect(CollapsibleDetailTextLayout.isOverflowing(fullHeight: 61, collapsedHeight: 60))
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 40, collapsedHeight: 60))
    }

    @Test func taskDefinitionCardAppearsOnlyWithActualContent() {
        #expect(!ConversationTaskDefinition.hasContent(description: " \n", acceptance: ""))
        #expect(ConversationTaskDefinition.hasContent(description: "", acceptance: "验收"))
        #expect(ConversationTaskDefinition.hasContent(description: "描述", acceptance: ""))
    }

    @Test func detailHeaderReservesAccessibleNativeActionTargets() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ConversationInspectorSection.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("headerActions: () -> HeaderActions"))
        #expect(source.contains("HStack(spacing: 2) { headerActions }"))
        #expect(source.contains(".frame(width: 44, height: 44)"))
        #expect(source.contains(".frame(width: 28, height: 28)"))
    }

    @Test func detailDisclosureMakesTheWholeTitleRowTheToggle() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ConversationInspectorSection.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("public struct ConversationDetailDisclosure<Header: View, Content: View>"))
        #expect(source.contains("Button { isExpanded.toggle() } label:"))
        #expect(source.contains("header.frame(maxWidth: .infinity, alignment: .leading)"))
        #expect(source.contains(".contentShape(Rectangle())"))
        #expect(source.contains(".accessibilityValue(isExpanded ? \"已展开\" : \"已收起\")"))
    }

    @Test func taskSummaryUsesRevisionAndInterventionConsistently() {
        let value: ClientInspectorValue = .object([
            "state": .string("ready"),
            "content": .object([
                "schemaVersion": .number(1),
                "focus": .string("当前重点"), "progress": .string("已完成"),
                "intervention": .string("required"), "reason": .string("等待确认"),
                "nextAction": .string("确认结果"), "generatedAt": .string("2026-10-02"),
                "basis": .object(["taskRevision": .number(7)])
            ])
        ])
        let current = ConversationTaskSummary(inspectorValue: value, taskRevision: 7)
        let stale = ConversationTaskSummary(inspectorValue: value, taskRevision: 8)
        #expect(current?.isCurrent == true)
        #expect(current?.needsIntervention == true)
        #expect(current?.stateLabel == "")
        #expect(stale?.isCurrent == false)
        #expect(stale?.needsIntervention == false)
        #expect(stale?.stateLabel == "旧摘要 · 待更新")
    }

    @Test func detailModulesUseContentColorWithoutNestedGlass() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ConversationInspectorSection.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("public struct ConversationDetailContentSurface: ViewModifier"))
        #expect(source.contains("ConversationContentSurface(cornerRadius: cornerRadius, isPanel: true)"))
        #expect(!source.contains("GlassEffectContainer"))
        let contentSource = try String(contentsOf: sourceURL.deletingLastPathComponent()
            .appendingPathComponent("ConversationContentSurface.swift"), encoding: .utf8)
        #expect(contentSource.contains("if withMaterial && !ConversationContentSurfacePolicy.suppressMessageMaterialForProfiling {"))
        #expect(contentSource.contains(".regularMaterial.opacity(ConversationContentSurfacePolicy.messageMaterialOpacity)"))
        #expect(source.contains("ConversationContentSurface(cornerRadius: cornerRadius, isPanel: true)"))
        #expect(!contentSource.contains("glassEffect"))
        #expect(source.contains(".modifier(ConversationDetailContentSurface(cornerRadius: 18))"))
        #expect(source.contains(".clipShape(shape)"))
        #expect(!source.contains(".background(Color.primary.opacity(0.055)"))
        #expect(!source.contains(".shadow("))
    }

    #if os(macOS)
    @MainActor @Test func detailColorLayerCountRemainsStableAfterLayout() throws {
        _ = NSApplication.shared

        let modules = ConversationDetailDashboard {
            VStack(spacing: 12) {
                ForEach(0..<3) { index in
                    Text("Detail \(index)").frame(height: 108)
                        .modifier(ConversationDetailModuleSurface())
                        .frame(width: 280)
                }
            }
        }
        .frame(width: 360, height: 560)
        let result = try inspectGlassLayers(modules)
        #expect(result.layerCount > 0)
        #expect(result.layerCountAfterLayout == result.layerCount)
    }
    #endif

    @Test func navigationRailSharesOneGlassCapsuleAcrossPlatforms() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/PlatformNavigationRail.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains(".platformGlassSurface(in: Capsule(), variant: .clear)"))
        #expect(!source.contains(".platformGlassSurface(in: Circle()"))
        #expect(source.contains("Button(action: onSettings)"))
        #expect(source.contains("Text(settingsTitle)"))
        #expect(source.contains(".frame(maxHeight: .infinity, alignment: verticalAlignment)"))
        #expect(source.contains(".accessibilityIdentifier(\"navigation-tab-capsule\")"))
        #expect(source.contains(".accessibilityIdentifier(item.accessibilityID)"))
        #expect(source.contains(".accessibilityValue(selected ? \"selected\" : \"not-selected\")"))
        #expect(source.contains(".buttonStyle(PlatformTabButtonStyle())"))
        #expect(source.contains("@Environment(\\.accessibilityReduceMotion)"))
        #expect(source.contains(".scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)"))
        #expect(source.contains(".opacity(configuration.isPressed ? 0.76 : 1)"))
    }
}

#if os(macOS)
@MainActor private func inspectGlassLayers<V: View>(_ view: V) throws
    -> (clipped: [Bool], layerCount: Int, layerCountAfterLayout: Int) {
    let host = NSHostingView(rootView: view)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 560),
                          styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.hasShadow = false
    window.orderFront(nil)
    defer { window.close() }
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    let root = try #require(host.layer)
    var clipped: [Bool] = []
    var count = 0
    func inspect(_ layer: CALayer, cardClip: Bool) {
        count += 1
        let clipsCard = cardClip || (
            (layer.masksToBounds || layer.mask != nil)
            && (layer.cornerRadius >= 18 || layer.mask != nil)
            && abs(layer.bounds.width - 280) < 1
            && abs(layer.bounds.height - 140) < 1
        )
        // Observe the compositor layer type without invoking private API.
        if String(describing: type(of: layer)).contains("BackdropLayer") {
            clipped.append(clipsCard)
        }
        for child in layer.sublayers ?? [] { inspect(child, cardClip: clipsCard) }
    }
    inspect(root, cardClip: false)
    let initialCount = count
    let initialClipped = clipped
    for _ in 0..<20 {
        host.needsLayout = true
        host.layoutSubtreeIfNeeded()
    }
    count = 0
    clipped = []
    inspect(root, cardClip: false)
    return (initialClipped, initialCount, count)
}
#endif
