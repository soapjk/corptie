import AppKit
import SwiftUI

/// Independent hosts joined by system edge constraints. Only the flexible
/// viewport consumes remaining height; accessory content never follows its layout.
struct ConversationRegionStack<Content: View, Accessory: View>: NSViewRepresentable {
    @Environment(\.self) private var environment
    var accessoryAtTop = false
    var accessoryHeight: CGFloat? = nil
    var accessoryOverlap: CGFloat = 0
    var floating: AnyView? = nil
    /// Part of the floating dock that is a transparent, centred control: the
    /// transcript may scroll underneath it instead of reserving blank rows.
    var floatingClearanceInset: CGFloat = 0
    @ViewBuilder var content: () -> Content
    @ViewBuilder var accessory: () -> Accessory

    private func accessoryRoot() -> AnyView {
        AnyView(accessory()
            .frame(maxWidth: .infinity, maxHeight: accessoryAtTop ? .infinity : nil, alignment: .topLeading)
            .environment(\.self, environment))
    }

    func makeNSView(context: Context) -> ConversationRegionContainer<AnyView, AnyView> {
        ConversationRegionContainer(content: AnyView(content().environment(\.self, environment)), accessory: accessoryRoot(),
            atTop: accessoryAtTop, height: accessoryHeight, overlap: accessoryOverlap,
            floatingClearanceInset: floatingClearanceInset,
            floating: floating.map { AnyView($0.environment(\.self, environment)) })
    }
    func updateNSView(_ view: ConversationRegionContainer<AnyView, AnyView>, context: Context) {
        // `AnyView` erases structure, so replacing either root rebuilds the
        // whole transcript + rail tree instead of diffing it. A live resize
        // only changes width: AppKit already drives that through the edge
        // constraints, so hold the newest roots until the gesture ends.
        view.applyRoots(content: AnyView(content().environment(\.self, environment)),
                        accessory: accessoryRoot(),
                        overlap: accessoryOverlap, floating: floating.map { AnyView($0.environment(\.self, environment)) })
    }
    static func dismantleNSView(_ view: ConversationRegionContainer<AnyView, AnyView>, coordinator: ()) {
        view.discardPendingRoots()
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ConversationRegionContainer<AnyView, AnyView>, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 1000, height: proposal.height ?? 700)
    }
}

@MainActor protocol ConversationFloatingRegion: AnyObject {
    var floatingRegionClearance: CGFloat? { get }
    var floatingClearanceDidLayout: ((CGFloat) -> Void)? { get set }
}

/// AppKit asks for an ideal height with an unspecified SwiftUI proposal. Bind
/// that measurement to the same native width used to place the accessory.
/// Only the frame wrapper changes on resize; the content and editor stay put.
struct ConversationWidthBoundRoot<Content: View>: View {
    var content: Content
    var width: CGFloat?
    var body: some View { content.frame(width: width, alignment: .topLeading) }
}

final class ConversationWidthBoundHost<Content: View>: NSHostingView<ConversationWidthBoundRoot<Content>> {
    var contentRoot: Content {
        get { rootView.content }
        set { rootView = .init(content: newValue, width: rootView.width) }
    }

    init(content: Content) { super.init(rootView: .init(content: content, width: nil)) }
    required init(rootView: ConversationWidthBoundRoot<Content>) { super.init(rootView: rootView) }
    required init?(coder: NSCoder) { fatalError() }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        guard newSize.width.isFinite else { return }
        let width = max(0, newSize.width)
        guard rootView.width != width else { return }
        rootView = .init(content: rootView.content, width: width)
    }
}

final class ConversationRegionContainer<Content: View, Accessory: View>: NSView, ConversationFloatingRegion {
    let content: NSHostingView<Content>
    let accessory: ConversationWidthBoundHost<Accessory>
    let floatingHost: NSHostingView<AnyView>
    private var pendingFloating: AnyView?
    private var hasFloating = false
    /// Only the opaque rows need reserved transcript space. The transparent
    /// jump-control slot floats over message text; reserving it produces a
    /// blank white band that clips the last visible line above the composer.
    var floatingRegionClearance: CGFloat? {
        hasFloating ? max(0, floatingHost.frame.height - floatingClearanceInset) : nil
    }
    var floatingClearanceDidLayout: ((CGFloat) -> Void)?
    private var contentBottom: NSLayoutConstraint?
    /// `NSWindow.inLiveResize` is not settable outside AppKit; tests drive the
    /// same branch through this seam.
    var liveResizeOverride: Bool?
    private var holdsRootUpdates: Bool { liveResizeOverride ?? (window?.inLiveResize == true) }
    private var pendingContent: Content?
    private var pendingAccessory: Accessory?
    private var observesLiveResizeEnd = false
    private let floatingClearanceInset: CGFloat
    private(set) var rootCommitCount = 0
    var hasPendingRoots: Bool { pendingContent != nil || pendingAccessory != nil }
    init(content: Content, accessory: Accessory, atTop: Bool, height: CGFloat?, overlap: CGFloat = 0,
         floatingClearanceInset: CGFloat = 0, floating: AnyView? = nil) {
        self.floatingClearanceInset = floatingClearanceInset
        self.content = NSHostingView(rootView: content)
        self.accessory = ConversationWidthBoundHost(content: accessory)
        floatingHost = NSHostingView(rootView: floating ?? AnyView(EmptyView().frame(height: 0)))
        hasFloating = floating != nil
        floatingHost.isHidden = floating == nil
        super.init(frame: .zero)
        self.content.sizingOptions = []
        self.accessory.sizingOptions = height == nil ? [.intrinsicContentSize] : []
        for host in [self.content as NSView, self.accessory as NSView, floatingHost as NSView] {
            host.translatesAutoresizingMaskIntoConstraints = false
            addSubview(host)
            NSLayoutConstraint.activate([
                host.leadingAnchor.constraint(equalTo: leadingAnchor),
                host.trailingAnchor.constraint(equalTo: trailingAnchor)
            ])
        }
        floatingHost.safeAreaRegions = []
        floatingHost.sizingOptions = [.intrinsicContentSize]
        floatingHost.setContentHuggingPriority(.required, for: .vertical)
        floatingHost.setContentCompressionResistancePriority(.required, for: .vertical)
        floatingHost.bottomAnchor.constraint(equalTo: self.accessory.topAnchor).isActive = true
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
    func applyRoots(content: Content, accessory: Accessory, overlap: CGFloat, floating: AnyView? = nil) {
        setAccessoryOverlap(overlap)
        guard holdsRootUpdates else {
            discardPendingRoots()
            commitRoots(content: content, accessory: accessory, floating: floating)
            return
        }
        pendingContent = content
        pendingAccessory = accessory
        pendingFloating = floating
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
        let floating = pendingFloating
        discardPendingRoots()
        commitRoots(content: content, accessory: accessory, floating: floating)
    }

    func discardPendingRoots() {
        if observesLiveResizeEnd {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didEndLiveResizeNotification, object: window)
            observesLiveResizeEnd = false
        }
        pendingContent = nil
        pendingAccessory = nil
        pendingFloating = nil
    }

    private func commitRoots(content: Content, accessory: Accessory, floating: AnyView? = nil) {
        hasFloating = floating != nil
        floatingHost.isHidden = floating == nil
        floatingHost.rootView = floating ?? AnyView(EmptyView().frame(height: 0))
        self.content.rootView = content
        self.accessory.contentRoot = accessory
        rootCommitCount += 1
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        // Floating controls can change height without resizing the viewport.
        // Publish only the native frame, after sibling constraints have settled.
        if let height = floatingRegionClearance { floatingClearanceDidLayout?(height) }
    }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
}
