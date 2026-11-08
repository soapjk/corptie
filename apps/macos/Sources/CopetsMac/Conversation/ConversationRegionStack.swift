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
        // `AnyView` erases structure, so replacing either root rebuilds the
        // whole transcript + rail tree instead of diffing it. A live resize
        // only changes width: AppKit already drives that through the edge
        // constraints, so hold the newest roots until the gesture ends.
        view.applyRoots(content: AnyView(content().environment(\.self, environment)),
                        accessory: accessoryRoot(),
                        overlap: accessoryOverlap)
    }
    static func dismantleNSView(_ view: ConversationRegionContainer<AnyView, AnyView>, coordinator: ()) {
        view.discardPendingRoots()
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ConversationRegionContainer<AnyView, AnyView>, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 1000, height: proposal.height ?? 700)
    }
}

final class ConversationRegionContainer<Content: View, Accessory: View>: NSView {
    let content: NSHostingView<Content>
    let accessory: NSHostingView<Accessory>
    private var contentBottom: NSLayoutConstraint?
    /// `NSWindow.inLiveResize` is not settable outside AppKit; tests drive the
    /// same branch through this seam.
    var liveResizeOverride: Bool?
    private var holdsRootUpdates: Bool { liveResizeOverride ?? (window?.inLiveResize == true) }
    private var pendingContent: Content?
    private var pendingAccessory: Accessory?
    private var observesLiveResizeEnd = false
    private(set) var rootCommitCount = 0
    var hasPendingRoots: Bool { pendingContent != nil || pendingAccessory != nil }
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

    /// Width changes during a drag are delivered by Auto Layout alone; the
    /// hosted SwiftUI trees still reflow on every frame. Only the *content*
    /// roots are held, so text keeps wrapping live while no view hierarchy is
    /// rebuilt until the gesture ends.
    func applyRoots(content: Content, accessory: Accessory, overlap: CGFloat) {
        setAccessoryOverlap(overlap)
        guard holdsRootUpdates else {
            discardPendingRoots()
            commitRoots(content: content, accessory: accessory)
            return
        }
        pendingContent = content
        pendingAccessory = accessory
        guard !observesLiveResizeEnd, let window else { return }
        NotificationCenter.default.addObserver(self, selector: #selector(liveResizeDidEnd),
            name: NSWindow.didEndLiveResizeNotification, object: window)
        observesLiveResizeEnd = true
    }

    @objc private func liveResizeDidEnd() {
        commitPendingRoots()
    }

    func commitPendingRoots() {
        guard let content = pendingContent, let accessory = pendingAccessory else {
            discardPendingRoots()
            return
        }
        discardPendingRoots()
        commitRoots(content: content, accessory: accessory)
    }

    func discardPendingRoots() {
        if observesLiveResizeEnd {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didEndLiveResizeNotification, object: window)
            observesLiveResizeEnd = false
        }
        pendingContent = nil
        pendingAccessory = nil
    }

    private func commitRoots(content: Content, accessory: Accessory) {
        self.content.rootView = content
        self.accessory.rootView = accessory
        rootCommitCount += 1
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
}
