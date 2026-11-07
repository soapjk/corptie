import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Native text owns wrapping and truncation. Expansion never measures a second
/// copy of the paragraph or changes a text container during a size proposal.
struct ConversationStampedParagraph: View {
    let title: String
    let text: String
    var expansion: Binding<Bool>?
    var expandLabel = "展开"
    var collapseLabel = "收起"
    @State private var localExpanded = false
    private var expanded: Binding<Bool> { expansion ?? $localExpanded }
    private var paragraph: Text {
        (Text(title.isEmpty ? "" : title + "：").foregroundColor(.accentColor).bold() + Text(text))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if expanded.wrappedValue && text.utf16.count > 2000 {
                    ScrollView(.vertical) {
                        paragraph.fixedSize(horizontal: false, vertical: true)
                            #if os(macOS)
                            .modifier(DetailScrollOwnerRegistration())
                            #endif
                    }.frame(height: 240)
                } else {
                    paragraph.lineLimit(expanded.wrappedValue ? nil : 3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.system(size: 12)).foregroundStyle(.secondary)
            .lineSpacing(2).textSelection(.enabled)
            if !text.isEmpty {
                Button(expanded.wrappedValue ? collapseLabel : expandLabel) { expanded.wrappedValue.toggle() }
                    .font(.system(size: 10, weight: .semibold)).buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityIdentifier("detail.paragraph.toggle")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { Button("复制正文") { copyBody() } }
        .accessibilityAction(named: Text(expanded.wrappedValue ? collapseLabel : expandLabel)) { expanded.wrappedValue.toggle() }
    }
    private func copyBody() {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}
