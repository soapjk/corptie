import AppKit
import CorptieConversation
import SwiftUI

@MainActor
final class ConsoleNativeSplitView: NSSplitView {
    // Column colors provide the boundary; keep the native divider's hit area.
    override func drawDivider(in rect: NSRect) {}

    // A viewport has no content-derived ideal size. In particular, querying
    // fittingSize must not recursively measure the SwiftUI trees it contains.
    override var fittingSize: NSSize { NSSize(width: 1000, height: 700) }
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }
    static let didEndDividerTracking = Notification.Name("ConsoleNativeSplitView.didEndDividerTracking")
    private(set) var isTrackingDivider = false

    override func mouseDown(with event: NSEvent) {
        isTrackingDivider = true
        defer {
            isTrackingDivider = false
            NotificationCenter.default.post(name: Self.didEndDividerTracking, object: window)
        }
        super.mouseDown(with: event)
    }

    static func isResizing(_ view: NSView) -> Bool {
        if view.window?.inLiveResize == true { return true }
        var ancestor: NSView? = view
        while let current = ancestor {
            if let split = current as? ConsoleNativeSplitView, split.isTrackingDivider { return true }
            ancestor = current.superview
        }
        return false
    }
}

/// AppKit owns the window-sized split. SwiftUI owns only each pane's content.
/// The hosting controllers survive navigation-mode changes and divider drags.
struct ConsolePaneContent<Content: View>: View {
    let content: () -> Content
    var columnRole: ConversationColumnRole = .transcript

    var body: some View {
        content().modifier(ConversationColumnSurface(columnRole)).modifier(ConversationSkinHost())
    }
}

/// Paint outside page padding and title-bar safe areas. Card/content geometry
/// stays unchanged, and the trailing page gutter belongs to the Detail canvas.
private struct DetailColumnVisibilityKey: EnvironmentKey {
    static let defaultValue: Binding<Bool>? = nil
}

extension EnvironmentValues {
    var detailColumnVisibility: Binding<Bool>? {
        get { self[DetailColumnVisibilityKey.self] }
        set { self[DetailColumnVisibilityKey.self] = newValue }
    }
}

struct ConsoleDetailColumnVisibility: ViewModifier {
    let isVisible: Bool
    func body(content: Content) -> some View {
        content.frame(width: isVisible ? ConversationDetailWidgetMetrics.railWidth : 0)
            .clipped().allowsHitTesting(isVisible).disabled(!isVisible).accessibilityHidden(!isVisible)
    }
}

struct ConsoleDetailColumnBackground: ViewModifier {
    var isVisible = true
    func body(content: Content) -> some View {
        content.background(alignment: .trailing) {
            if isVisible {
                ConversationColumnBackground(.inspector)
                    .frame(width: ConversationDetailWidgetMetrics.railWidth + MainWindowPageLayoutMetrics.outerPadding)
            }
        }
    }
}

struct ConsoleWindowSplitView<Sidebar: View, Detail: View>: NSViewControllerRepresentable {
    let mode: ConsoleNavigationMode
    let isActive: Bool
    let sidebar: () -> Sidebar
    let detail: () -> Detail

    init(mode: ConsoleNavigationMode, isActive: Bool,
         @ViewBuilder sidebar: @escaping () -> Sidebar, @ViewBuilder detail: @escaping () -> Detail) {
        self.mode = mode
        self.isActive = isActive
        self.sidebar = sidebar
        self.detail = detail
    }

    func makeNSViewController(context: Context) -> ConsoleSplitController<ConsolePaneContent<Sidebar>, ConsolePaneContent<Detail>> {
        ConsoleSplitController(mode: mode, sidebar: ConsolePaneContent(content: sidebar, columnRole: .sidebar), detail: ConsolePaneContent(content: detail))
    }

    func updateNSViewController(_ controller: ConsoleSplitController<ConsolePaneContent<Sidebar>, ConsolePaneContent<Detail>>, context: Context) {
        controller.update(mode: mode, isActive: isActive, sidebar: ConsolePaneContent(content: sidebar, columnRole: .sidebar), detail: ConsolePaneContent(content: detail))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: ConsoleSplitController<ConsolePaneContent<Sidebar>, ConsolePaneContent<Detail>>, context: Context) -> CGSize? {
        // This is a window-filling container, not content-sized. Avoid asking
        // Auto Layout to measure the entire hosted conversation for its ideal size.
        CGSize(width: proposal.width ?? 1000, height: proposal.height ?? 700)
    }
}

@MainActor
final class ConsolePaneController<Content: View>: NSViewController {
    let host: NSHostingController<Content>
    private let isSidebar: Bool

    init(root: Content, isSidebar: Bool) {
        host = NSHostingController(rootView: root)
        host.sizingOptions = []
        self.isSidebar = isSidebar
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        // The window owns the canvas wallpaper. Panes are transparent so the
        // same image is not duplicated or recropped during divider drags.
        view = NSView()
        addChild(host)
        host.view.identifier = NSUserInterfaceItemIdentifier(isSidebar ? "console.sidebar.content" : "console.detail.content")
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }
}

@MainActor
protocol ConsoleSplitContentUpdating: AnyObject {
    var contentUpdateCount: Int { get }
}

@MainActor
final class ConsoleSplitController<Sidebar: View, Detail: View>: NSSplitViewController, ConsoleSplitContentUpdating {
    private let sidebarController: ConsolePaneController<Sidebar>
    private let detailController: ConsolePaneController<Detail>
    private var mode: ConsoleNavigationMode
    private var isActive = true
    private(set) var contentUpdateCount = 0
    private var restoredWidth = false
    private var isRestoring = false
    private var saveWork: DispatchWorkItem?

    init(mode: ConsoleNavigationMode, sidebar: Sidebar, detail: Detail) {
        self.mode = mode
        sidebarController = ConsolePaneController(root: sidebar, isSidebar: true)
        detailController = ConsolePaneController(root: detail, isSidebar: false)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let native = ConsoleNativeSplitView()
        splitView = native
        view = native
    }

    override func viewDidLoad() {
        splitView.isVertical = true
        splitView.dividerStyle = .thin
        // The console's Work/Task surfaces already draw their own cards.
        // A system Sidebar item adds a full-column material behind them.
        let sidebar = NSSplitViewItem(viewController: sidebarController)
        sidebar.allowsFullHeightLayout = true
        sidebar.canCollapse = true
        sidebar.minimumThickness = 284
        sidebar.maximumThickness = 900
        addSplitViewItem(sidebar)
        let detail = NSSplitViewItem(viewController: detailController)
        // Reserve the transcript column beside the two-cell widget rail.
        detail.minimumThickness = ConversationDetailWidgetMetrics.railWidth + 264
        addSplitViewItem(detail)
        super.viewDidLoad()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        if !restoredWidth, splitView.bounds.width > 0 {
            restoredWidth = true
            restoreWidth()
        }
    }

    func update(mode: ConsoleNavigationMode, isActive: Bool, sidebar: Sidebar, detail: Detail) {
        let trace = SessionSwitchTrace.shared.start(.splitUpdate)
        defer { SessionSwitchTrace.shared.finish(trace) }
        // Commit the transition to inactive once, then leave retained hidden
        // hosts alone. Reactivation always receives the latest root values.
        if isActive || self.isActive {
            let sidebarTrace = SessionSwitchTrace.shared.start(.sidebarRoot)
            sidebarController.host.rootView = sidebar
            SessionSwitchTrace.shared.finish(sidebarTrace)
            let detailTrace = SessionSwitchTrace.shared.start(.detailRoot)
            detailController.host.rootView = detail
            SessionSwitchTrace.shared.finish(detailTrace)
            contentUpdateCount += 1
        }
        self.isActive = isActive
        if self.mode != mode {
            saveWidth()
            self.mode = mode
            restoreWidth()
        }
    }

    override func splitView(_ splitView: NSSplitView, shouldHideDividerAt dividerIndex: Int) -> Bool {
        let defaultResult = super.splitView(splitView, shouldHideDividerAt: dividerIndex)
        return dividerIndex == 0 ? false : defaultResult
    }

    override func splitView(_ splitView: NSSplitView, additionalEffectiveRectOfDividerAt dividerIndex: Int) -> NSRect {
        let defaultRect = super.splitView(splitView, additionalEffectiveRectOfDividerAt: dividerIndex)
        guard dividerIndex == 0, splitViewItems.first?.isCollapsed == true else { return defaultRect }
        // AppKit still owns divider tracking; leave a narrow reachable edge.
        return NSRect(x: 0, y: 0, width: 6, height: splitView.bounds.height)
    }

    private var widthKey: String {
        mode == .taskCards ? "console.nativeSidebar.cardsWidth" : "console.nativeSidebar.listWidth.v2"
    }

    private func restoreWidth() {
        guard isViewLoaded, splitView.bounds.width > 0 else { return }
        saveWork?.cancel()
        isRestoring = true
        let stored = CorptieAppEnvironment.userDefaults.double(forKey: widthKey)
        let preferred = stored > 0 ? stored : (mode == .taskCards ? 540 : 284)
        let maximum = max(284, splitView.bounds.width - 581)
        splitView.setPosition(min(max(284, preferred), maximum), ofDividerAt: 0)
        isRestoring = false
    }

    private func saveWidth() {
        guard isViewLoaded, !splitViewItems[0].isCollapsed else { return }
        let width = sidebarController.view.frame.width
        if width >= 284 { CorptieAppEnvironment.userDefaults.set(width, forKey: widthKey) }
    }

    override func splitViewDidResizeSubviews(_ notification: Notification) {
        super.splitViewDidResizeSubviews(notification)
        guard restoredWidth, !isRestoring else { return }
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.saveWidth() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
}
