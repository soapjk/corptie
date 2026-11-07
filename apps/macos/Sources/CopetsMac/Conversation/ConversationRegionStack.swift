import AppKit
import SwiftUI

/// Independent hosts joined by system edge constraints. Only the flexible
/// viewport consumes remaining height; accessory content never follows its layout.
struct ConversationRegionStack<Content: View, Accessory: View>: NSViewRepresentable {
    @Environment(\.self) private var environment
    var accessoryAtTop = false
    var accessoryHeight: CGFloat? = nil
    var accessoryOverlap: CGFloat = 0
    @ViewBuilder var content: () -> Content
    @ViewBuilder var accessory: () -> Accessory

    private func accessoryRoot() -> AnyView {
        AnyView(accessory()
            .frame(maxWidth: .infinity, maxHeight: accessoryAtTop ? .infinity : nil, alignment: .topLeading)
            .environment(\.self, environment))
    }

    func makeNSView(context: Context) -> ConversationRegionContainer<AnyView, AnyView> {
        ConversationRegionContainer(content: AnyView(content().environment(\.self, environment)), accessory: accessoryRoot(),
            atTop: accessoryAtTop, height: accessoryHeight, overlap: accessoryOverlap)
    }
    func updateNSView(_ view: ConversationRegionContainer<AnyView, AnyView>, context: Context) {
        view.content.rootView = AnyView(content().environment(\.self, environment))
        view.accessory.rootView = accessoryRoot()
        view.setAccessoryOverlap(accessoryOverlap)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ConversationRegionContainer<AnyView, AnyView>, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 1000, height: proposal.height ?? 700)
    }
}

final class ConversationRegionContainer<Content: View, Accessory: View>: NSView {
    let content: NSHostingView<Content>
    let accessory: NSHostingView<Accessory>
    private var contentBottom: NSLayoutConstraint?
    init(content: Content, accessory: Accessory, atTop: Bool, height: CGFloat?, overlap: CGFloat = 0) {
        self.content = NSHostingView(rootView: content)
        self.accessory = NSHostingView(rootView: accessory)
        super.init(frame: .zero)
        self.content.sizingOptions = []
        self.accessory.sizingOptions = height == nil ? [.intrinsicContentSize] : []
        for host in [self.content as NSView, self.accessory as NSView] {
            host.translatesAutoresizingMaskIntoConstraints = false
            addSubview(host)
            NSLayoutConstraint.activate([
                host.leadingAnchor.constraint(equalTo: leadingAnchor),
                host.trailingAnchor.constraint(equalTo: trailingAnchor)
            ])
        }
        self.content.safeAreaRegions = []
        self.accessory.safeAreaRegions = []
        self.accessory.setContentHuggingPriority(.required, for: .vertical)
        self.accessory.setContentCompressionResistancePriority(.required, for: .vertical)
        if let height { self.accessory.heightAnchor.constraint(equalToConstant: height).isActive = true }
        if atTop {
            NSLayoutConstraint.activate([
                self.accessory.topAnchor.constraint(equalTo: topAnchor),
                self.content.topAnchor.constraint(equalTo: self.accessory.bottomAnchor),
                self.content.bottomAnchor.constraint(equalTo: bottomAnchor)
            ])
        } else {
            let bottom = self.content.bottomAnchor.constraint(equalTo: self.accessory.topAnchor, constant: max(0, overlap))
            contentBottom = bottom
            NSLayoutConstraint.activate([
                self.content.topAnchor.constraint(equalTo: topAnchor), bottom,
                self.accessory.bottomAnchor.constraint(equalTo: bottomAnchor)
            ])
        }
        self.content.heightAnchor.constraint(greaterThanOrEqualToConstant: 0).isActive = true
    }
    /// A fixed quick-message strip may overlap the transcript. AppKit maintains
    /// these edges; there is no resize callback or geometry state feedback.
    func setAccessoryOverlap(_ overlap: CGFloat) {
        let value = max(0, overlap)
        if contentBottom?.constant != value { contentBottom?.constant = value }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
}
