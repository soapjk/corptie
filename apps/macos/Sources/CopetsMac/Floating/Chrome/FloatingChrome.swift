import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct LiquidGlassControlBackground: View {
    let cornerRadius: CGFloat

    var body: some View {
        if #available(macOS 26.0, *) {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.clear)
                .glassEffect(.clear.tint(Color.white.opacity(0.035)), in: .rect(cornerRadius: cornerRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.8)
                }
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.8)
                }
        }
    }
}

private struct GlassIconButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isSelected ? CorptiePalette.amber : CorptiePalette.primaryText)
            .background { LiquidGlassControlBackground(cornerRadius: 15) }
            .opacity(configuration.isPressed ? 0.68 : 1)
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
    }
}

struct HoverRevealCloseButton: View {
    @State private var isHovering = false
    private let hoverProbeSize = CGSize(width: 18, height: 18)

    var body: some View {
        MainPanelCloseButton()
            .opacity(isHovering ? 1 : 0)
            .scaleEffect(isHovering ? 1 : 0.86)
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .frame(width: hoverProbeSize.width, height: hoverProbeSize.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering
            }
    }
}

private struct MainPanelCloseButton: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isHovering = false

    var body: some View {
        Button {
            let mainWindow = NSApp.keyWindow
            mainWindow?.orderOut(nil)
        } label: {
            ZStack {
                Circle()
                    .fill(Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.37, blue: 0.32, alpha: 1.0)))
                    .overlay(
                        Circle()
                            .strokeBorder(Color.black.opacity(0.14), lineWidth: 0.5)
                    )

                if isHovering {
                    Image(systemName: "xmark")
                        .font(.system(size: 6.5, weight: .black))
                        .foregroundStyle(Color.black.opacity(0.58))
                }
            }
            .frame(width: 12, height: 12)
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .onHover { hovering in
            isHovering = hovering
        }
        .help(L10n("Close"))
    }
}

struct EnvironmentModeBadge: View {
    private var modeLabel: String {
        CorptieAppEnvironment.displayName
    }

    private var modeIcon: String {
        CorptieAppEnvironment.isDevelopment ? "hammer.fill" : "sparkles"
    }

    private var modeColor: Color {
        CorptieAppEnvironment.isDevelopment ? CorptiePalette.amber : CorptiePalette.softBlue
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: modeIcon)
                .font(.system(size: 10.5, weight: .semibold))
            Text(modeLabel)
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
        }
        .foregroundStyle(modeColor)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule()
                .fill(modeColor.opacity(0.16))
                .overlay {
                    Capsule()
                        .stroke(modeColor.opacity(0.42), lineWidth: 0.9)
                }
        )
        .help("Environment: \(modeLabel) (\(CorptieAppEnvironment.backendPort))")
    }
}

enum ListHeightMetric: Hashable {
    case header
    case cards
    case browserTop
    case scrollTop
}

struct ListHeightPreferenceKey: PreferenceKey {
    static let defaultValue: [ListHeightMetric: CGFloat] = [:]

    static func reduce(value: inout [ListHeightMetric: CGFloat], nextValue: () -> [ListHeightMetric: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newValue in newValue })
    }
}

extension View {
    func measureListHeight(_ metric: ListHeightMetric) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(key: ListHeightPreferenceKey.self, value: [metric: proxy.size.height])
            }
        )
    }

    func measureListMinY(_ metric: ListHeightMetric, coordinateSpace: String) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ListHeightPreferenceKey.self,
                    value: [metric: proxy.frame(in: .named(coordinateSpace)).minY]
                )
            }
        )
    }

}

struct LiquidGlassPanelBackground: View {
    @EnvironmentObject private var panelFocusState: PanelFocusState
    let cornerRadius: CGFloat

    var body: some View {
        if !SessionListPerformanceFlags.current.glassEffectsEnabled {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor))
        } else if #available(macOS 26.0, *) {
            ZStack {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.clear)
                    .glassEffect(.clear, in: .rect(cornerRadius: cornerRadius))

                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .opacity(isFocused ? 0.34 : 0.14)

                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(isFocused ? CorptiePalette.glassVeilFocused : CorptiePalette.glassVeilIdle)
                    .opacity(isFocused ? 0.38 : 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .animation(.easeInOut(duration: 0.18), value: isFocused)
        } else {
            VisualEffectView(material: .popover, blendingMode: .behindWindow)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }

    private var isFocused: Bool {
        panelFocusState.isFocused
    }
}

struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView {
        DragView()
    }

    func updateNSView(_ nsView: DragView, context: Context) {}

    final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            bounds.contains(point) ? self : nil
        }

        override func mouseDragged(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }
}

struct FastHoverTrackingArea: NSViewRepresentable {
    let hoverChanged: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        view.hoverChanged = hoverChanged
        return view
    }

    func updateNSView(_ nsView: TrackingView, context: Context) {
        nsView.hoverChanged = hoverChanged
    }

    final class TrackingView: NSView {
        var hoverChanged: ((Bool) -> Void)?

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self,
                userInfo: nil
            ))
        }

        override func mouseEntered(with event: NSEvent) {
            hoverChanged?(true)
        }

        override func mouseExited(with event: NSEvent) {
            hoverChanged?(false)
        }
    }
}

struct BottomEdgeResizeHandle: NSViewRepresentable {
    func makeNSView(context: Context) -> ResizeView {
        ResizeView()
    }

    func updateNSView(_ nsView: ResizeView, context: Context) {}

    final class ResizeView: NSView {
        private var startingMouseLocation: NSPoint?
        private var startingFrame: NSRect?

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(
                rect: bounds,
                options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
                owner: self
            ))
        }

        override func mouseEntered(with event: NSEvent) {
            NSCursor.resizeUpDown.push()
        }

        override func mouseExited(with event: NSEvent) {
            NSCursor.pop()
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            startingMouseLocation = NSEvent.mouseLocation
            startingFrame = window.frame
            (window as? FloatingPanel)?.isPerformingCustomLiveResize = true
        }

        override func mouseDragged(with event: NSEvent) {
            guard let window, let startingMouseLocation, let startingFrame else { return }
            let deltaY = NSEvent.mouseLocation.y - startingMouseLocation.y
            let proposedHeight = startingFrame.height - deltaY
            let height = min(window.maxSize.height, max(window.minSize.height, proposedHeight))
            var frame = startingFrame
            frame.size.height = height
            frame.origin.y = startingFrame.maxY - height
            window.setFrame(frame, display: true)
        }

        override func mouseUp(with event: NSEvent) {
            if let panel = window as? FloatingPanel {
                panel.isPerformingCustomLiveResize = false
                panel.customResizeDidEnd?()
            }
            startingMouseLocation = nil
            startingFrame = nil
        }
    }
}
