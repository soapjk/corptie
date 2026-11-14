import AppKit
import ApplicationServices
import ScreenCaptureKit

@MainActor
final class NativeEngine {
    private let keys: [String: CGKeyCode] = ["return": 36, "tab": 48, "escape": 53, "space": 49,
        "delete": 51, "forwardDelete": 117, "left": 123, "right": 124, "up": 126, "down": 125,
        "home": 115, "end": 119, "pageUp": 116, "pageDown": 121, "a": 0, "c": 8, "v": 9,
        "x": 7, "z": 6, "s": 1, "f": 3, "l": 37, "n": 45, "t": 17, "w": 13, "r": 15]

    func perform(_ method: String, _ p: Parameters) async throws -> [String: Any] {
        if method == "status" {
            return ["engine": "independent", "protocol": "corptie-computer-use/v1", "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
                "permissions": ["accessibility": AXIsProcessTrusted() ? "granted" : "required",
                    "screenCapture": CGPreflightScreenCaptureAccess() ? "granted" : "required"],
                "activationPolicy": "never", "capturePolicy": "on-demand"]
        }
        if method == "apps" {
            return ["apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map {
                ["pid": $0.processIdentifier, "name": $0.localizedName ?? "", "bundleIdentifier": $0.bundleIdentifier ?? ""] as [String: Any]
            }]
        }
        guard let pid = p.pid, pid > 0, let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated else {
            throw NativeFailure("TARGET_GONE", "Select a running PID")
        }
        let windows = windowInfo(pid)
        if method == "windows" { return ["pid": pid, "windows": windows] }
        guard let windowID = p.windowId, let info = windows.first(where: { ($0["id"] as? UInt32) == windowID }),
              let rect = info["bounds"] as? [String: Double], let x = rect["x"], let y = rect["y"],
              let width = rect["width"], let height = rect["height"] else {
            throw NativeFailure("WINDOW_GONE", "Window ID must belong to selected PID")
        }
        let frame = CGRect(x: x, y: y, width: width, height: height)
        if method == "screenshot" { return try await screenshot(pid, windowID) }
        if !AXIsProcessTrusted() {
            // The SDK exposes this immutable dictionary key through a mutable
            // C global. Use its stable CFString value without relaxing Swift isolation.
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            throw NativeFailure("ACCESSIBILITY_REQUIRED", "Allow CorptieComputerUse in System Settings > Privacy & Security > Accessibility, then retry")
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
        let window = try axWindow(app, info, frame)
        switch method {
        case "read":
            var remaining = 500
            return ["pid": pid, "windowId": windowID, "tree": tree(window, [], 0, &remaining), "truncated": remaining == 0]
        case "click":
            let element: AXUIElement
            if let path = p.element { element = try resolve(window, path) }
            else {
                guard let px = p.x, let py = p.y, px.isFinite, py.isFinite,
                      px >= 0, py >= 0, px < width, py < height else {
                    throw NativeFailure("INVALID_COORDINATES", "Coordinates must be inside the selected window in logical points")
                }
                var remaining = 500
                guard let match = pressable(window, CGPoint(x: x + px, y: y + py), 0, &remaining) else {
                    throw NativeFailure("UNSUPPORTED_CONTROL", "No AXPress control at these coordinates; background pixel clicks are not synthesized globally")
                }
                element = match
            }
            try axCheck(AXUIElementPerformAction(element, kAXPressAction as CFString))
            return ["delivery": "ax_action_completed", "activation": "not_requested"]
        case "type":
            guard let text = p.text, text.utf16.count <= 10000 else { throw NativeFailure("INVALID_TEXT", "Text must be at most 10000 UTF-16 units") }
            if let path = p.element {
                let element = try resolve(window, path)
                try require((attribute(element, kAXSubroleAttribute) as? String) != "AXSecureTextField", "SECURE_CONTROL", "Secure text controls are not supported")
                var settable = DarwinBoolean(false)
                try axCheck(AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable))
                try require(settable.boolValue, "UNSUPPORTED_CONTROL", "Element does not support AX value assignment")
                try axCheck(AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString))
                return ["delivery": "ax_value_set", "activation": "not_requested"]
            }
            try focusedWindow(app, window)
            // PID-directed events do not activate the target. An app may decline
            // background events; report delivery, never claim observed success.
            let units = Array(text.utf16)
            var start = 0
            while start < units.count {
                var end = min(start + 20, units.count)
                if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
                try unicode(Array(units[start..<end]), pid)
                start = end
            }
            return ["delivery": "pid_events_posted_unverified", "activation": "not_requested"]
        case "key":
            try focusedWindow(app, window)
            guard let name = p.key, let code = keys[name] else { throw NativeFailure("INVALID_KEY", "Unsupported key") }
            let flags = try modifierFlags(p.modifiers ?? [])
            try key(code, flags, pid)
            return ["delivery": "pid_events_posted_unverified", "activation": "not_requested"]
        case "scroll":
            try focusedWindow(app, window)
            let dx = p.deltaX ?? 0, dy = p.deltaY ?? 0
            try require(abs(Int(dx)) <= 2000 && abs(Int(dy)) <= 2000, "INVALID_SCROLL", "Scroll delta outside limit")
            let px = p.x ?? width / 2, py = p.y ?? height / 2
            try require(px.isFinite && py.isFinite && px >= 0 && py >= 0 && px < width && py < height, "INVALID_COORDINATES", "Scroll point outside selected window")
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                throw NativeFailure("EVENT_FAILED", "Cannot create scroll event")
            }
            event.location = CGPoint(x: x + px, y: y + py)
            event.postToPid(pid)
            return ["delivery": "pid_event_posted_unverified", "activation": "not_requested"]
        default: throw NativeFailure("UNKNOWN_METHOD", "Unsupported native operation")
        }
    }

    private func windowInfo(_ pid: Int32) -> [[String: Any]] {
        let entries = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return entries.compactMap { entry in
            guard (entry[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (entry[kCGWindowLayer as String] as? Int) == 0,
                  let id = entry[kCGWindowNumber as String] as? UInt32,
                  let raw = entry[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: raw as CFDictionary), frame.width > 0, frame.height > 0 else { return nil }
            return ["id": id, "title": entry[kCGWindowName as String] as? String ?? "",
                "onScreen": entry[kCGWindowIsOnscreen as String] as? Bool ?? false,
                "bounds": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]]
        }
    }
    private func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
    }
    private func children(_ element: AXUIElement) -> [AXUIElement] {
        // Read a bounded slice rather than copying a potentially huge child array.
        var values: CFArray?
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success, count > 0,
              AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, 100), &values) == .success else { return [] }
        return values as? [AXUIElement] ?? []
    }
    private func bounds(_ element: AXUIElement) -> CGRect? {
        guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(p, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeDowncast(s, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    private func axWindow(_ app: AXUIElement, _ info: [String: Any], _ frame: CGRect) throws -> AXUIElement {
        let candidates = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter {
            guard let b = bounds($0) else { return false }
            return abs(b.minX - frame.minX) < 2 && abs(b.minY - frame.minY) < 2 && abs(b.width - frame.width) < 2 && abs(b.height - frame.height) < 2
        }
        // Public AX has no stable CGWindowID attribute. Refuse ambiguous matches
        // rather than using private _AXUIElementGetWindow or a guessed window.
        let title = info["title"] as? String ?? ""
        let named = candidates.filter { (attribute($0, kAXTitleAttribute) as? String) == title }
        let matches = named.isEmpty ? candidates : named
        guard matches.count == 1, let result = matches.first else { throw NativeFailure("WINDOW_UNRESOLVED", "Cannot uniquely correlate CG and AX window; refresh windows") }
        return result
    }
    private func resolve(_ window: AXUIElement, _ path: [Int]) throws -> AXUIElement {
        try require(path.count <= 24, "INVALID_ELEMENT", "Element path too deep")
        var element = window
        for index in path {
            let values = children(element)
            guard values.indices.contains(index) else { throw NativeFailure("STALE_ELEMENT", "Read the window again; element path changed") }
            element = values[index]
        }
        return element
    }
    private func tree(_ element: AXUIElement, _ path: [Int], _ depth: Int, _ remaining: inout Int) -> [String: Any] {
        guard remaining > 0 else { return ["truncated": true] }
        remaining -= 1
        var node: [String: Any] = ["element": path]
        let secure = (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
        for (key, name) in [(kAXRoleAttribute, "role"), (kAXSubroleAttribute, "subrole"), (kAXTitleAttribute, "title"), (kAXDescriptionAttribute, "description"), (kAXValueAttribute, "value")] {
            if secure && name == "value" { continue }
            if let value = attribute(element, key) as? String { node[name] = String(value.prefix(2048)) }
        }
        if let b = bounds(element) { node["bounds"] = ["x": b.minX, "y": b.minY, "width": b.width, "height": b.height] }
        if depth < 12 && remaining > 0 {
            var nodes: [[String: Any]] = []
            for (index, child) in children(element).enumerated() {
                if remaining == 0 { break }
                nodes.append(tree(child, path + [index], depth + 1, &remaining))
            }
            node["children"] = nodes
        } else { node["truncated"] = true }
        return node
    }
    private func pressable(_ element: AXUIElement, _ point: CGPoint, _ depth: Int, _ remaining: inout Int) -> AXUIElement? {
        guard depth <= 12, remaining > 0 else { return nil }
        remaining -= 1
        guard let b = bounds(element), b.contains(point) else { return nil }
        for child in children(element).reversed() {
            if let result = pressable(child, point, depth + 1, &remaining) { return result }
        }
        var actions: CFArray?
        if AXUIElementCopyActionNames(element, &actions) == .success,
           (actions as? [String] ?? []).contains(kAXPressAction) { return element }
        return nil
    }
    private func focusedWindow(_ app: AXUIElement, _ window: AXUIElement) throws {
        guard let focused = attribute(app, kAXFocusedWindowAttribute), CFEqual(focused, window) else {
            throw NativeFailure("WINDOW_NOT_FOCUSED", "Target must be the application's focused window; Corptie will not activate or raise it")
        }
    }
    private func axCheck(_ result: AXError) throws {
        if result != .success { throw NativeFailure("AX_ERROR", "Accessibility operation failed (\(result.rawValue)); refresh target or check permissions") }
    }
    private func modifierFlags(_ names: [String]) throws -> CGEventFlags {
        var flags: CGEventFlags = []
        for name in names {
            switch name {
            case "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option": flags.insert(.maskAlternate)
            case "control": flags.insert(.maskControl)
            default: throw NativeFailure("INVALID_MODIFIER", "Unknown modifier")
            }
        }
        return flags
    }
    private func key(_ code: CGKeyCode, _ flags: CGEventFlags, _ pid: Int32) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw NativeFailure("EVENT_FAILED", "Cannot create key event") }
        down.flags = flags; up.flags = flags
        down.postToPid(pid); up.postToPid(pid)
    }
    private func unicode(_ units: [UniChar], _ pid: Int32) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw NativeFailure("EVENT_FAILED", "Cannot create text event") }
        units.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        down.postToPid(pid); up.postToPid(pid)
    }
    private func screenshot(_ pid: Int32, _ id: UInt32) async throws -> [String: Any] {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            throw NativeFailure("SCREEN_CAPTURE_REQUIRED", "Allow CorptieComputerUse Screen Recording in System Settings, then retry")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == pid }) else {
            throw NativeFailure("WINDOW_GONE", "Window is not capturable")
        }
        let config = SCStreamConfiguration()
        let scale = min(1, 1920 / max(window.frame.width, window.frame.height))
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let png = bitmap.representation(using: .png, properties: [:]), png.count <= 16 * 1024 * 1024 else {
            throw NativeFailure("IMAGE_TOO_LARGE", "Screenshot exceeds native image budget")
        }
        return ["pid": pid, "windowId": id, "image": png.base64EncodedString(), "width": image.width, "height": image.height,
            "coordinateSpace": "window-relative logical points", "windowWidth": window.frame.width, "windowHeight": window.frame.height]
    }
}
