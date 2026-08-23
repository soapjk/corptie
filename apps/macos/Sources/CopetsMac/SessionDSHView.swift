import SwiftUI
import WebKit

// Session DSH 适配探针（P0）：内嵌一个 WKWebView，加载 DSH 的 web 宿主前端，
// 用于验证 DSH 的 React + Cordis 插件化 UI 能否脱离其 agent 后端、在 Corptie 中渲染。
// 这是独立于现有 Session Tab 的隔离实验页，不改动任何现有会话 UI。

struct SessionDSHView: View {
    @EnvironmentObject private var sidebarState: TabSidebarState

    // DSH web 前端静态快照由 Corptie backend 直接服务（路径 B2，脱离 DSH host）：
    // 加载 Corptie backend 的根路径 `/`，其 index.html 已注入 __DSH_BOOT__，
    // /api/session.* 由 dshRpcAdapter 响应（同源，无需桥接）。
    var body: some View {
        DSHWebView(store: .shared, isSidebarVisible: sidebarState.isVisible)
    }
}

// 应用级共享的 DSH WebView。App 启动时预加载，Tab 切换只重新挂载同一个实例，
// 避免重复初始化 WebKit、下载插件 bundle 和等待 React/Cordis boot。
@MainActor
final class SessionDSHWebViewStore {
    static let shared = SessionDSHWebViewStore()

    let webView: WKWebView
    private let coordinator: DSHWebView.Coordinator
    private let url = CorptieAppEnvironment.backendBaseURL
    private var retryWorkItem: DispatchWorkItem?
    private var presentationWorkItem: DispatchWorkItem?
    private var retryAttempt = 0
    private var requestedSidebarVisibility = true

    private init() {
        let coordinator = DSHWebView.Coordinator()
        let configuration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()
        userContentController.add(coordinator, name: "console")
        configuration.userContentController = userContentController

        self.coordinator = coordinator
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        coordinator.onNavigationFailure = { [weak self] in
            self?.scheduleRetry()
        }
        coordinator.onNavigationFinish = { [weak self] in
            self?.retryAttempt = 0
            self?.retryWorkItem?.cancel()
            self?.retryWorkItem = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self?.applyRequestedSidebarVisibility()
            }
        }
    }

    func preload() {
        loadIfNeeded()
    }

    func loadIfNeeded() {
        guard webView.url == nil, webView.isLoading == false else { return }
        webView.load(URLRequest(url: url))
    }

    // Preloading happens before the WKWebView has a visible size. Ask WebKit
    // for one presentation refresh after SwiftUI has attached it to a window.
    // Never force layoutSubtreeIfNeeded/displayIfNeeded here: doing so from a
    // representable lifecycle callback can recursively enter AppKit's display
    // cycle while NSHostingView is updating safe-area constraints.
    func didBecomeVisible() {
        presentationWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.webView.window != nil else { return }
            self.webView.needsDisplay = true
            self.webView.evaluateJavaScript("window.dispatchEvent(new Event('resize'))") { _, _ in }
            self.applyRequestedSidebarVisibility()
        }
        presentationWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: workItem)
    }

    func setSidebarVisible(_ isVisible: Bool) {
        guard requestedSidebarVisibility != isVisible else { return }
        requestedSidebarVisibility = isVisible
        applyRequestedSidebarVisibility()
    }

    /// DSH advertises its sidebar state on the stable AppFrame data attribute
    /// and exposes a localized, accessible toggle button. Use those declared
    /// DOM contracts instead of coupling the native client to generated CSS
    /// module names. One script runs only when this tab's toggle changes.
    private func applyRequestedSidebarVisibility() {
        guard webView.url != nil else { return }
        let requested = requestedSidebarVisibility ? "true" : "false"
        let script = """
        (() => {
          const frame = document.querySelector('[data-sidebar-collapsed]')
            || Array.from(document.querySelectorAll('div')).find(
              element => getComputedStyle(element).display === 'grid'
                && element.querySelector('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"], button[aria-label="Open sidebar"], button[aria-label="Collapse sidebar"]')
            );
          if (!frame) return 'unavailable';
          const collapsed = frame.hasAttribute('data-sidebar-collapsed');
          const requestedVisible = \(requested);
          if (requestedVisible !== collapsed) return 'unchanged';
          const toggle = frame.querySelector(
            'button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"], button[aria-label="Open sidebar"], button[aria-label="Collapse sidebar"]'
          );
          if (!toggle) return 'missing-toggle';
          toggle.click();
          return 'toggled';
        })()
        """
        webView.evaluateJavaScript(script) { result, error in
            if let error {
                NSLog("[SessionDSH] sidebar synchronization failed: \(error)")
            } else if let result = result as? String,
                      result == "unavailable" || result == "missing-toggle" {
                NSLog("[SessionDSH] sidebar synchronization unavailable: \(result)")
            }
        }
    }

    private func scheduleRetry() {
        retryWorkItem?.cancel()
        retryAttempt += 1
        let delay = min(pow(2.0, Double(retryAttempt - 1)) * 0.5, 5.0)
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.webView.load(URLRequest(url: self.url))
        }
        retryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }
}

// 最小 WKWebView 桥接：仅负责加载并展示 DSH 前端，不做任何 JS 交互或数据注入。
struct DSHWebView: NSViewRepresentable {
    let store: SessionDSHWebViewStore
    let isSidebarVisible: Bool

    func makeNSView(context: Context) -> WKWebView {
        DispatchQueue.main.async {
            store.didBecomeVisible()
        }
        return store.webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        store.loadIfNeeded()
        store.setSidebarVisible(isSidebarVisible)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onNavigationFailure: (() -> Void)?
        var onNavigationFinish: (() -> Void)?

        // 注入 console 捕获桥：劫持 window.console，把日志转发到 native 侧。
        private static let consoleBridge = """
        (() => {
          if (window.__dshConsoleHooked) return;
          window.__dshConsoleHooked = true;
          const send = (level, args) => {
            try {
              const msg = args.map(a => {
                if (a instanceof Error) return a.stack || a.message;
                if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
                return String(a);
              }).join(' ');
              window.webkit.messageHandlers.console.postMessage({ level, msg: msg.slice(0, 500) });
            } catch {}
          };
          ['log','info','warn','error'].forEach(level => {
            const orig = console[level];
            console[level] = function(...args) { send(level, args); orig.apply(console, args); };
          });
          window.addEventListener('error', e => {
            try { window.webkit.messageHandlers.console.postMessage({ level: 'error', msg: (e.message || '') + ' @ ' + (e.filename||'') + ':' + (e.lineno||'') }); } catch {}
          });
          window.addEventListener('unhandledrejection', e => {
            try { window.webkit.messageHandlers.console.postMessage({ level: 'error', msg: 'unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason.message || String(e.reason)) || '') }); } catch {}
          });
        })();
        """

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("[SessionDSH] provisional navigation failed: \(error)")
            onNavigationFailure?()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("[SessionDSH] navigation failed: \(error)")
            onNavigationFailure?()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            NSLog("[SessionDSH] did finish loading: \(webView.url?.absoluteString ?? "nil")")
            onNavigationFinish?()
            // 注入 console 捕获桥，并延迟+重试探针：module script 是 defer 的，
            // didFinish 时 React 可能尚未挂载，轮询直到 root 有内容或超时。
            webView.evaluateJavaScript(Self.consoleBridge, in: nil, in: .page) { _ in }
            self.probe(webView, attempt: 0)
        }

        private func probe(_ webView: WKWebView, attempt: Int) {
            webView.evaluateJavaScript(
                """
                (() => {
                  const root = document.getElementById('root');
                  const count = root ? root.children.length : -1;
                  const text = root ? (root.innerText || '').slice(0, 200) : '';
                  const boot = typeof window.__DSH_BOOT__ !== 'undefined';
                  const mods = document.querySelectorAll('script[type="module"]').length;
                  return JSON.stringify({ rootExists: !!root, childCount: count, text, bootManifest: boot, moduleScripts: mods, attempt: \(attempt) });
                })()
                """
            ) { result, error in
                if let error = error {
                    NSLog("[SessionDSH] JS probe error: \(error)")
                } else {
                    NSLog("[SessionDSH] JS probe result: \(result ?? "nil")")
                }
                // 若 root 仍为空且未超时，继续轮询（最多 10 次，间隔 1s）。
                let mounted = (result as? String)?.contains("\"childCount\":0") == false
                if !mounted && attempt < 10 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        self.probe(webView, attempt: attempt + 1)
                    }
                }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "console", let body = message.body as? [String: Any] else { return }
            let level = body["level"] as? String ?? "log"
            let msg = body["msg"] as? String ?? ""
            NSLog("[SessionDSH][console.\(level)] \(msg)")
        }
    }
}
