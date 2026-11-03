import AppKit
import SwiftUI

/// Publish only committed text, so Chinese/Japanese marked text does not
/// replace the result grid while the input method is still composing.
struct RegistrySearchField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let identifier: String
    var focusRequest = 0

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.delegate = context.coordinator
        field.sendsSearchStringImmediately = true
        field.controlSize = .regular
        field.font = .preferredFont(forTextStyle: .body)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateNSView(_ field: NSSearchField, context: Context) {
        context.coordinator.parent = self
        field.placeholderString = placeholder
        field.setAccessibilityLabel(placeholder)
        field.setAccessibilityIdentifier(identifier)
        let isComposing = (field.currentEditor() as? NSTextView)?.hasMarkedText() == true
        if !isComposing, field.stringValue != text { field.stringValue = text }
        if context.coordinator.lastFocusRequest != focusRequest {
            context.coordinator.lastFocusRequest = focusRequest
            DispatchQueue.main.async { [weak field] in
                guard let field, let window = field.window else { return }
                window.makeFirstResponder(field)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var parent: RegistrySearchField
        var lastFocusRequest = 0

        init(_ parent: RegistrySearchField) { self.parent = parent }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField,
                (field.currentEditor() as? NSTextView)?.hasMarkedText() != true
            else { return }
            parent.text = field.stringValue
        }

        func control(
            _ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector
        )
            -> Bool
        {
            guard commandSelector == #selector(NSResponder.cancelOperation(_:)),
                !textView.hasMarkedText()
            else { return false }
            if !parent.text.isEmpty {
                parent.text = ""
                control.stringValue = ""
            } else {
                control.window?.makeFirstResponder(nil)
            }
            return true
        }
    }
}
