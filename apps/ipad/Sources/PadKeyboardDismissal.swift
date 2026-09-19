import SwiftUI
import UIKit

/// One passive observer per window, not a gesture on every message row.
struct PadKeyboardDismissal: UIViewRepresentable {
    func makeUIView(context: Context) -> Observer { Observer() }
    func updateUIView(_ view: Observer, context: Context) {}
    static func dismantleUIView(_ view: Observer, coordinator: ()) { view.detach() }

    final class Observer: UIView, UIGestureRecognizerDelegate {
        private weak var observedWindow: UIWindow?
        private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))

        override func didMoveToWindow() {
            super.didMoveToWindow()
            detach()
            guard let window else { return }
            observedWindow = window
            tap.cancelsTouchesInView = false
            tap.delegate = self
            window.addGestureRecognizer(tap)
        }
        func detach() {
            observedWindow?.removeGestureRecognizer(tap)
            observedWindow = nil
        }
        @objc private func dismissKeyboard() { observedWindow?.endEditing(true) }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var target = touch.view
            while let view = target {
                if view is UITextView || view is UITextField { return false }
                target = view.superview
            }
            return true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
