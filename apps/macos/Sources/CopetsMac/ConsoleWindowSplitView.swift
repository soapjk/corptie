import AppKit
import SwiftUI

@MainActor
final class ConsoleNativeSplitView: NSSplitView {
    var windowChanged: (() -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        windowChanged?()
    }

    override func layout() {
        super.layout()
        windowChanged?()
    }
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
struct ConsoleWindowSplitView<Sidebar: View, Detail: View>: NSViewControllerRepresentable {
    let mode: ConsoleNavigationMode
    let isActive: Bool
    let sidebar: Sidebar
    let detail: Detail

    init(mode: ConsoleNavigationMode, isActive: Bool,
         @ViewBuilder sidebar: () -> Sidebar, @ViewBuilder detail: () -> Detail) {
        self.mode = mode
        self.isActive = isActive
        self.sidebar = sidebar()
        self.detail = detail()
    }

    func makeNSViewController(context: Context) -> ConsoleSplitController<Sidebar, Detail> {
        ConsoleSplitController(mode: mode, sidebar: sidebar, detail: detail)
    }

    func updateNSViewController(_ controller: ConsoleSplitController<Sidebar, Detail>, context: Context) {
        controller.update(mode: mode, isActive: isActive, sidebar: sidebar, detail: detail)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: ConsoleSplitController<Sidebar, Detail>, context: Context) -> CGSize? {
        // This is a window-filling container, not content-sized. Avoid asking
        // Auto Layout to measure the entire hosted conversation for its ideal size.
        CGSize(width: proposal.width ?? 1000, height: proposal.height ?? 700)
    }
}

@MainActor
final class ConsolePaneController<Content: View>: NSViewController {
    let host: NSHostingController<Content>
    private let isSidebar: Bool
    private var contentHeightConstraint: NSLayoutConstraint?

    init(root: Content, isSidebar: Bool) {
        host = NSHostingController(rootView: root)
        host.sizingOptions = []
        self.isSidebar = isSidebar
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        if isSidebar {
            let material = NSVisualEffectView()
            material.material = .sidebar
            material.blendingMode = .behindWindow
            material.state = .followsWindowActiveState
            view = material
        } else {
            view = NSView()
        }
        addChild(host)
        host.view.identifier = NSUserInterfaceItemIdentifier(isSidebar ? "console.sidebar.content" : "console.detail.content")
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        let height = host.view.heightAnchor.constraint(equalTo: view.heightAnchor)
        contentHeightConstraint = height
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            height,
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    func updateWindowLayoutGuide() {
        guard let window = view.window, let contentView = window.contentView else { return }
        // Keep constraints inside this pane's layout engine. A cross-host
        // constraint to the window guide collapsed the hosting view to zero.
        // Read only the system-owned unobscured rect; never measure content.
        let unobscured = contentView.convert(window.contentLayoutRect, from: nil)
        let inset = max(0, contentView.bounds.maxY - unobscured.maxY)
        if contentHeightConstraint?.constant != -inset {
            contentHeightConstraint?.constant = -inset
        }
    }
}

@MainActor
final class ConsoleSplitController<Sidebar: View, Detail: View>: NSSplitViewController {
    private let sidebarController: ConsolePaneController<Sidebar>
    private let detailController: ConsolePaneController<Detail>
    private var mode: ConsoleNavigationMode
    private var isActive = true
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
        native.windowChanged = { [weak self] in self?.attachToolbar() }
        splitView = native
        view = native
    }

    override func viewDidLoad() {
        splitView.isVertical = true
        splitView.dividerStyle = .thin
        let sidebar = NSSplitViewItem(sidebarWithViewController: sidebarController)
        sidebar.allowsFullHeightLayout = true
        sidebar.canCollapse = true
        sidebar.minimumThickness = 284
        sidebar.maximumThickness = 900
        addSplitViewItem(sidebar)
        let detail = NSSplitViewItem(viewController: detailController)
        detail.minimumThickness = 580
        addSplitViewItem(detail)
        super.viewDidLoad()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        attachToolbar()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        if !restoredWidth, splitView.bounds.width > 0 {
            restoredWidth = true
            restoreWidth()
        }
        attachToolbar()
    }

    func update(mode: ConsoleNavigationMode, isActive: Bool, sidebar: Sidebar, detail: Detail) {
        sidebarController.host.rootView = sidebar
        detailController.host.rootView = detail
        self.isActive = isActive
        if self.mode != mode {
            saveWidth()
            self.mode = mode
            restoreWidth()
        }
        attachToolbar()
    }

    private func attachToolbar() {
        sidebarController.updateWindowLayoutGuide()
        detailController.updateWindowLayoutGuide()
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
        mode == .taskCards ? "console.nativeSidebar.cardsWidth" : "console.nativeSidebar.listWidth"
    }

    private func restoreWidth() {
        guard isViewLoaded, splitView.bounds.width > 0 else { return }
        saveWork?.cancel()
        isRestoring = true
        let stored = CorptieAppEnvironment.userDefaults.double(forKey: widthKey)
        let preferred = stored > 0 ? stored : (mode == .taskCards ? 540 : 364)
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
