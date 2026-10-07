import Testing
import Foundation
import CorptieClientCore
import SwiftUI
#if os(macOS)
import AppKit
#endif
@testable import CorptieConversation

struct ConversationInspectorTests {
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
        #expect(contentSource.contains("if withMaterial {"))
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
        #expect(source.contains(".platformGlassSurface(in: Circle(), interactive: true, variant: .clear)"))
        #expect(source.contains(".accessibilityIdentifier(\"navigation-tab-capsule\")"))
        #expect(source.contains(".accessibilityIdentifier(item.accessibilityID)"))
        #expect(source.contains(".accessibilityValue(selected ? \"selected\" : \"not-selected\")"))
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
