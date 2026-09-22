import SwiftUI
import CorptieConversation

/// Production adapter. It deliberately keeps the
/// existing attributed-text cache, measured sizes and custom TextKit view.
struct MacSharedMessageTextCard: View {
    let row: AppKitChatTimelineRow
    let layout: NativeTimelineLayoutCache.Layout
    var baseDirectory: String?
    var copy: () -> Void = {}
    var toggle: () -> Void = {}

    static func supports(_ row: AppKitChatTimelineRow) -> Bool {
        supportsProcess(row) || (row.nativeStyle != .process && !row.showsHeader && !row.isCollaboration
            && row.collaborationRoute == nil && row.processCount == nil && row.expandableTurnId == nil
            && row.actions.isEmpty && !row.showsCollaborationSentStatus
            && row.images.isEmpty && row.rawStatusText.isEmpty)
    }

    static func supportsProcess(_ row: AppKitChatTimelineRow) -> Bool {
        row.nativeStyle == .process && row.processCount != nil && row.expandableTurnId != nil
            && !row.isCollaboration && row.collaborationRoute == nil
            && row.actions.isEmpty && row.images.isEmpty && !row.showsCollaborationSentStatus
    }

    var body: some View {
        Group {
            if row.nativeStyle == .process { processCard }
            else { messageCard }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity,
            alignment: row.nativeStyle == .user ? .topTrailing : .topLeading)
        .padding(.horizontal, 2)
        .padding(.top, 1)
    }

    private var processCard: some View {
        ProcessCard(summary: row.processSummary, symbol: row.processState.symbolName,
                    tint: Color(nsColor: row.processState.color), expanded: row.isExpanded, toggle: toggle) {
            VStack(alignment: .leading, spacing: 8) {
                MeasuredMessageText(text: layout.attributedText,
                    size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight),
                    baseDirectory: baseDirectory)
                    .frame(width: layout.cardWidth - 20, height: layout.textHeight)
                if layout.rawStatusHeight > 0 {
                    ProcessRawStatusText(text: row.rawStatusText)
                        .frame(width: layout.cardWidth - 20, height: layout.rawStatusHeight)
                }
            }
        }
        .frame(width: layout.cardWidth, height: layout.rowHeight - 2, alignment: .topLeading)
    }

    private var messageCard: some View {
        MessageTextCard(messageID: row.id, role: row.nativeStyle == .user ? .user : .agent,
            timestamp: row.hoverTimestamp, showsActions: row.showsMessageActionBar,
            actionsAlwaysVisible: false, cardWidth: layout.cardWidth,
            cardHeight: layout.rowHeight - (row.showsMessageActionBar ? 28 : 2), copy: copy) {
                MeasuredMessageText(text: layout.attributedText,
                    size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight),
                    baseDirectory: baseDirectory)
                    .frame(width: layout.cardWidth - 20, height: layout.textHeight)
            }
    }
}

@MainActor
protocol AppKitChatRowRendering: AnyObject {
    func updateCallbacks(onToggleExpansion: @escaping (String) -> Void,
                         onAction: @escaping (AppKitChatTimelineRow.Action) -> Void)
    func updateLinkContext(baseDirectory: String?)
    func setContent(_ row: AppKitChatTimelineRow, availableWidth: CGFloat, baseDirectory: String?,
                    onToggleExpansion: @escaping (String) -> Void,
                    onAction: @escaping (AppKitChatTimelineRow.Action) -> Void)
    func updateLayoutIfContentUnchanged(_ row: AppKitChatTimelineRow, availableWidth: CGFloat) -> Bool
}

/// One hosting tree per reusable native row; no duplicate legacy view tree.
final class AppKitSharedMessageTextCell: NSTableCellView, AppKitChatRowRendering {
    private var host: NSHostingView<MacSharedMessageTextCard>?
    private var row: AppKitChatTimelineRow?
    private var measuredLayout: NativeTimelineLayoutCache.Layout?
    private var baseDirectory: String?
    private var measuredWidth: CGFloat?
    private var onToggleExpansion: (String) -> Void = { _ in }
    private(set) var contentConfigurationCount = 0
    private(set) var widthLayoutUpdateCount = 0

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func updateCallbacks(onToggleExpansion: @escaping (String) -> Void,
                         onAction: @escaping (AppKitChatTimelineRow.Action) -> Void) {
        self.onToggleExpansion = onToggleExpansion
    }

    func updateLinkContext(baseDirectory: String?) {
        guard self.baseDirectory != baseDirectory else { return }
        self.baseDirectory = baseDirectory
        updateHost()
    }

    func setContent(_ row: AppKitChatTimelineRow, availableWidth: CGFloat, baseDirectory: String? = nil,
                    onToggleExpansion: @escaping (String) -> Void,
                    onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in }) {
        precondition(MacSharedMessageTextCard.supports(row))
        self.row = row; self.baseDirectory = baseDirectory
        self.onToggleExpansion = onToggleExpansion
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        measuredWidth = availableWidth
        contentConfigurationCount += 1
        updateHost()
    }

    @discardableResult
    func updateLayoutIfContentUnchanged(_ row: AppKitChatTimelineRow, availableWidth: CGFloat) -> Bool {
        guard self.row?.id == row.id, self.row?.contentRevision == row.contentRevision else { return false }
        guard measuredWidth != availableWidth else { return true }
        measuredWidth = availableWidth
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        updateHost()
        return true
    }

    private func updateHost() {
        guard let row, let measuredLayout else { return }
        let root = MacSharedMessageTextCard(row: row, layout: measuredLayout, baseDirectory: baseDirectory,
            copy: { [weak self] in self?.copyRepresentedMessage() },
            toggle: { [weak self] in self?.toggleRepresentedProcess() })
        if let host { host.rootView = root }
        else {
            let host = NSHostingView(rootView: root)
            host.sizingOptions = [] // The cached native row height owns sizing.
            host.frame = bounds
            host.autoresizingMask = [.width, .height]
            addSubview(host)
            self.host = host
        }
        needsLayout = true
    }

    override func layout() {
        if host?.frame != bounds { host?.frame = bounds }
        super.layout()
    }

    func copyRepresentedMessage() {
        guard let text = row?.copyText else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func toggleRepresentedProcess() {
        guard let turnID = row?.expandableTurnId else { return }
        onToggleExpansion(turnID)
    }
}

private struct ProcessRawStatusText: NSViewRepresentable {
    let text: String
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.backgroundColor = .black.withAlphaComponent(0.035)
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 6
        let view = NSTextView()
        view.identifier = .init("chat.timeline.raw-status")
        view.isEditable = false; view.isSelectable = true; view.isRichText = false
        view.drawsBackground = false
        view.font = .monospacedSystemFont(ofSize: 9.5, weight: .regular)
        view.textColor = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
        view.textContainerInset = NSSize(width: 4, height: 4)
        view.isHorizontallyResizable = false; view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view
        return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) {
        guard let document = view.documentView as? NSTextView else { return }
        if document.string != text { document.string = text }
    }
}

private struct MeasuredMessageText: NSViewRepresentable {
    let text: NSAttributedString
    let size: CGSize
    let baseDirectory: String?
    final class Coordinator { var text: NSAttributedString? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NativeTimelineTextView { NativeTimelineTextView() }
    func updateNSView(_ view: NativeTimelineTextView, context: Context) {
        view.linkBaseDirectory = baseDirectory
        if context.coordinator.text !== text {
            view.textStorage?.setAttributedString(text)
            context.coordinator.text = text
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTimelineTextView, context: Context) -> CGSize? { size }
}
