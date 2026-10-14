import SwiftUI
import Observation
import WebKit
import CorptieClientCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ConversationDetailWebCard: View {
    let state: ClientDetailCardState
    let descriptor: ClientDetailRenderDescriptor
    let actions: ConversationDetailActions
    let scope: String
    @State private var model = ConversationDetailWebModel()
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if ConversationDetailWebRegistry.supports(descriptor) {
                ConversationDetailWebHost(state: state, descriptor: descriptor, actions: actions, scope: scope,
                    scheme: scheme, textSize: textSize, model: model)
                    .frame(maxWidth: .infinity).frame(height: model.height)
                    .background(GeometryReader { proxy in Color.clear.preference(key: DetailWebWidthKey.self, value: proxy.size.width) })
                    .onPreferenceChange(DetailWebWidthKey.self) { model.setWidth($0) }
                    .onAppear { model.resume() }.onDisappear { model.suspend() }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary)
                    Button("重新加载卡片") { model.reload() }.buttonStyle(.plain).foregroundStyle(Color.accentColor)
                }
            } else {
                Label("网页卡片版本不可用", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private var textSize: CGFloat {
        switch typeSize {
        case .xSmall, .small, .medium, .large: 12
        case .xLarge: 14
        case .xxLarge: 16
        case .xxxLarge: 18
        default: 22
        }
    }
}

private struct DetailWebWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

@MainActor @Observable private final class ConversationDetailWebModel: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var height: CGFloat = 48
    var error: String?
    @ObservationIgnored private weak var web: WKWebView?
    @ObservationIgnored private var state: ClientDetailCardState?
    @ObservationIgnored private var actions: ConversationDetailActions?
    @ObservationIgnored private var descriptor: ClientDetailRenderDescriptor?
    @ObservationIgnored private var token = UUID().uuidString
    @ObservationIgnored private var active = true
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var inFlight = false
    @ObservationIgnored private var sentStamp = ""
    @ObservationIgnored private var lastSignature = ""
    @ObservationIgnored private var sequence = 0
    @ObservationIgnored private var layout = 0
    @ObservationIgnored private var width: CGFloat = 0
    @ObservationIgnored private var textSize: CGFloat = 12
    @ObservationIgnored private var scheme = "light"
    @ObservationIgnored private var reloads = 0

    func make() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, contentWorld: .defaultClient, name: "corptieDetail")
        if let package = ConversationDetailWebRegistry.package {
            config.userContentController.addUserScript(WKUserScript(source: package.script, injectionTime: .atDocumentEnd,
                forMainFrameOnly: true, in: .defaultClient))
        }
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = false
        view.underPageBackgroundColor = .clear
        #if !os(macOS)
        view.isOpaque = false
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        #endif
        web = view
        if let package = ConversationDetailWebRegistry.package {
            view.loadFileURL(package.entry, allowingReadAccessTo: package.entry.deletingLastPathComponent())
        }
        return view
    }
    func update(state: ClientDetailCardState, descriptor: ClientDetailRenderDescriptor, actions: ConversationDetailActions,
                scheme: ColorScheme, textSize: CGFloat) {
        self.state = state; self.descriptor = descriptor; self.actions = actions
        let newScheme = scheme == .dark ? "dark" : "light"
        if self.scheme != newScheme || self.textSize != textSize { layout += 1 }
        self.scheme = newScheme; self.textSize = textSize
        send()
    }
    func setWidth(_ value: CGFloat) {
        guard value.isFinite, value > 0, abs(value - width) >= 0.5 else { return }
        width = value; layout += 1; send()
    }
    func suspend() { active = false; token = UUID().uuidString; lastSignature = ""; inFlight = false }
    func resume() { active = true; send() }
    func reload() {
        guard active, let web, let package = ConversationDetailWebRegistry.package else { return }
        token = UUID().uuidString; ready = false; inFlight = false; lastSignature = ""; sequence = 0; error = nil
        web.loadFileURL(package.entry, allowingReadAccessTo: package.entry.deletingLastPathComponent())
    }
    func dismantle(_ view: WKWebView) {
        suspend(); view.stopLoading(); view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "corptieDetail", contentWorld: .defaultClient)
        view.configuration.userContentController.removeAllUserScripts()
        web = nil; state = nil; actions = nil
    }
    private func send() {
        guard active, ready, !inFlight, width > 0, let web, let state, let descriptor,
              ConversationDetailWebRegistry.supports(descriptor), let binding = descriptor.dataBinding,
              let actions else { return }
        let sections = state.card.data[binding]?["sections"].items ?? []
        let offered = state.card.actions.filter { $0.kind == "navigation" }
        let buttons: [[String: Any]] = offered.map { ["id": $0.id, "label": $0.label.fallback,
            "enabled": $0.available && actions.canPerform($0)] }
        let sectionData = sections.map { item -> [String: String] in
            ["id": item["id"].text ?? "", "title": item["title"].text ?? "", "preview": item["preview"].text ?? "", "body": item["body"].text ?? ""]
        }
        let payload: [String: Any] = ["instanceToken": token, "dataStamp": state.card.dataRevision,
            "layoutVersion": layout, "sections": sectionData, "actions": buttons, "expanded": state.webExpandedSections,
            "scheme": scheme, "textSize": textSize, "accent": accentHex()]
        guard let encoded = try? JSONSerialization.data(withJSONObject: payload, options: .sortedKeys),
              encoded.count <= 256 * 1024, let signature = String(data: encoded, encoding: .utf8),
              signature != lastSignature else { return }
        lastSignature = signature; sentStamp = state.card.dataRevision; inFlight = true
        let sendingToken = token
        web.callAsyncJavaScript("globalThis.corptieDetailApply(update)", arguments: ["update": payload],
            in: nil, in: .defaultClient) { [weak self] result in
            guard let self, self.active, self.token == sendingToken else { return }
            self.inFlight = false
            if case .failure = result { self.error = "网页卡片更新失败"; return }
            self.send()
        }
    }
    private func accentHex() -> String {
        #if os(macOS)
        guard let color = NSColor(Color.accentColor).usingColorSpace(.deviceRGB) else { return "#007aff" }
        return String(format: "#%02x%02x%02x", Int(color.redComponent * 255), Int(color.greenComponent * 255), Int(color.blueComponent * 255))
        #else
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(Color.accentColor).getRed(&r, green: &g, blue: &b, alpha: &a) else { return "#007aff" }
        return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
        #endif
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard active, message.frameInfo.isMainFrame, message.frameInfo.request.url == ConversationDetailWebRegistry.package?.entry,
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "ready", body.keys.count == 1 { ready = true; lastSignature = ""; send(); return }
        guard let state, body["instanceToken"] as? String == token,
              body["dataStamp"] as? String == state.card.dataRevision,
              body["dataStamp"] as? String == sentStamp, body["layoutVersion"] as? Int == layout,
              let next = body["sequence"] as? Int, next > sequence,
              Set(body.keys) == Set(["type", "instanceToken", "dataStamp", "layoutVersion", "sequence", "payload"]),
              let payload = body["payload"] as? [String: Any] else { return }
        sequence = next
        switch type {
        case "size":
            guard Set(payload.keys) == ["height"], let value = payload["height"] as? Double,
                  value.isFinite, value >= 0, value <= 100000 else { return }
            let next = max(1, ceil(value))
            if abs(next - height) >= 0.5 { height = next }
        case "presentation":
            guard Set(payload.keys) == Set(["sectionID", "expanded"]), let id = payload["sectionID"] as? String,
                  let expanded = payload["expanded"] as? Bool else { return }
            state.setWebSectionExpanded(id, expanded)
        case "actionIntent":
            guard Set(payload.keys) == ["actionID"], let id = payload["actionID"] as? String,
                  let action = state.card.actions.first(where: { $0.id == id }), action.available,
                  action.kind == "navigation" || action.kind == "read" && action.operation == "detail.refresh",
                  actions?.canPerform(action) == true else { return }
            actions?.perform(action, [:])
        case "applied": break
        default: break
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        navigationAction.request.url == ConversationDetailWebRegistry.package?.entry ? .allow : .cancel
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { self.error = "网页卡片加载失败" }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { self.error = "网页卡片加载失败" }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard active, reloads < 1, let package = ConversationDetailWebRegistry.package else { error = "网页卡片进程已退出"; return }
        reloads += 1; token = UUID().uuidString; ready = false; inFlight = false; lastSignature = ""; sequence = 0
        webView.loadFileURL(package.entry, allowingReadAccessTo: package.entry.deletingLastPathComponent())
    }
}

#if os(macOS)
private struct ConversationDetailWebHost: NSViewRepresentable {
    let state: ClientDetailCardState; let descriptor: ClientDetailRenderDescriptor; let actions: ConversationDetailActions
    let scope: String; let scheme: ColorScheme; let textSize: CGFloat; let model: ConversationDetailWebModel
    func makeNSView(context: Context) -> WKWebView { let view = model.make(); updateNSView(view, context: context); return view }
    func updateNSView(_ view: WKWebView, context: Context) { model.update(state: state, descriptor: descriptor, actions: actions, scheme: scheme, textSize: textSize) }
    static func dismantleNSView(_ view: WKWebView, coordinator: ()) {
        (view.navigationDelegate as? ConversationDetailWebModel)?.dismantle(view)
    }
}
#else
private struct ConversationDetailWebHost: UIViewRepresentable {
    let state: ClientDetailCardState; let descriptor: ClientDetailRenderDescriptor; let actions: ConversationDetailActions
    let scope: String; let scheme: ColorScheme; let textSize: CGFloat; let model: ConversationDetailWebModel
    func makeUIView(context: Context) -> WKWebView { let view = model.make(); updateUIView(view, context: context); return view }
    func updateUIView(_ view: WKWebView, context: Context) { model.update(state: state, descriptor: descriptor, actions: actions, scheme: scheme, textSize: textSize) }
    static func dismantleUIView(_ view: WKWebView, coordinator: ()) {
        (view.navigationDelegate as? ConversationDetailWebModel)?.dismantle(view)
    }
}
#endif
