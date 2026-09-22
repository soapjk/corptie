import SwiftUI

// Feasibility probe, not the product card or a visual-parity implementation.
struct ProbeRow: Identifiable {
    let id: String
    var text: String
    var revision = 0
    var expanded = false
    var processing = true
}

struct SharedMessageCard: View {
    let row: ProbeRow
    let toggle: () -> Void
    let copy: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Corptie").font(.system(size: 11, weight: .medium))
                Spacer()
                if row.processing { Label("Processing", systemImage: "ellipsis.circle") }
            }
            SelectableBody(text: row.text)
            Button(action: toggle) {
                Label("工具执行过程", systemImage: row.expanded ? "chevron.down" : "chevron.right")
            }
            if row.expanded {
                Text("读取源码\n检查状态\n校验跨平台布局").font(.system(size: 11))
            }
            Button("复制") { copy(row.text) }
        }
        .font(.system(size: 10.5))
        .padding(10)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.1)))
        .accessibilityIdentifier("probe-card-\(row.id)")
    }
}

// Only the selectable text leaf is platform-specific; card composition is shared.
#if os(macOS)
import AppKit
struct SelectableBody: NSViewRepresentable {
    let text: String
    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView()
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.font = .systemFont(ofSize: 11, weight: .medium)
        return view
    }
    func updateNSView(_ view: NSTextView, context: Context) {
        if view.string != text { view.string = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0,
              let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height))
    }
}
#else
import UIKit
struct SelectableBody: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.font = .systemFont(ofSize: 11, weight: .medium)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
}

@MainActor
func makeProbeCell(row: ProbeRow, toggle: @escaping () -> Void, copy: @escaping (String) -> Void) -> UICollectionViewCell {
    let cell = UICollectionViewCell()
    cell.contentConfiguration = UIHostingConfiguration {
        SharedMessageCard(row: row, toggle: toggle, copy: copy)
    }.margins(.all, 0)
    return cell
}
#endif
