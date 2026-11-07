import Testing
import Foundation
#if os(macOS)
import AppKit
import SwiftUI
@testable import CorptieConversation

@MainActor struct StampedParagraphTests {
    private final class Expansion { var value = false }
    @Test func nativePreviewRespectsExternalExpansionAndLongTextCap() {
        for width in [180.0, 300.0, 480.0] {
            for length in [30, 200] {
                let state = Expansion()
                let source = String(repeating: "完整正文👨‍👩‍👧‍👦 e\u{301}。", count: length)
                func root() -> some View {
                    ConversationStampedParagraph(title: "描述", text: source,
                        expansion: Binding(get: { state.value }, set: { state.value = $0 }))
                        .frame(width: width)
                }
                let host = NSHostingView(rootView: root())
                host.frame = CGRect(x: 0, y: 0, width: width, height: 500)
                host.layoutSubtreeIfNeeded()
                let collapsed = host.fittingSize.height
                #expect(collapsed > 0 && collapsed < 90)
                state.value = true; host.rootView = root(); host.layoutSubtreeIfNeeded()
                let expanded = host.fittingSize.height
                #expect(expanded > collapsed)
                if source.utf16.count > 2000 { #expect(expanded < 280) }
                state.value = false; host.rootView = root(); host.layoutSubtreeIfNeeded()
                #expect(abs(host.fittingSize.height - collapsed) < 1)
            }
        }
    }

    @Test func shortTextKeepsNaturalHeightAcrossNarrowAndWideProposals() {
        for width in [180.0, 300.0, 480.0] {
            let host = NSHostingView(rootView: ConversationStampedParagraph(title: "事实", text: "使用中文回复").frame(width: width))
            host.frame = CGRect(x: 0, y: 0, width: width, height: 100)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height > 0 && host.fittingSize.height < 70)
        }
    }

    @Test func memoryAndTaskPathsUseSharedParagraphWithoutRedundantLabels() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/CorptieConversation")
        let native = try String(contentsOf: directory.appendingPathComponent("ConversationNativeBusinessDetail.swift"), encoding: .utf8)
        #expect(!native.contains("命中时的内容快照"))
        #expect(!native.contains("title: \"内容\""))
        #expect(native.contains("NativeBusinessTextSection(title: kindTitle"))
        #expect(native.contains("ConversationStampedParagraph(title: title"))
        let task = try String(contentsOf: directory.appendingPathComponent("ConversationInspectorSection.swift"), encoding: .utf8)
        #expect(task.contains("ConversationStampedParagraph(title: titles[index]"))
    }

}
#endif
