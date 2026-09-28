import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerInputTextView: NSViewRepresentable {
    let controller: ComposerEditorController
    let placeholder: String
    let font: NSFont
    var textInsetHeight: CGFloat = 6
    var onFocusChange: (Bool) -> Void = { _ in }
    var onSendableTextChange: (Bool) -> Void = { _ in }
    var onContentHeightChange: (CGFloat) -> Void = { _ in }
    var onPasteImages: (NSPasteboard) -> Bool = { _ in false }
    var onMentionQueryChange: (ComposerMentionQuery?) -> Void = { _ in }
    var onMentionAnchorChange: (UnitPoint) -> Void = { _ in }
    var onMentionCommand: (ComposerMentionCommand) -> Bool = { _ in false }
    let onSubmit: (ComposerDraftBuffer.Submission) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.borderType = .noBorder
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        let textView = ComposerSubmitTextView()
        textView.delegate = context.coordinator
        textView.placeholder = placeholder
        textView.font = font
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.autoresizingMask = [.width]
        textView.string = controller.draft.text
        textView.onFocusChange = onFocusChange
        textView.onSubmit = context.coordinator.submit
        textView.onPasteImages = onPasteImages
        textView.onMentionCommand = onMentionCommand

        scrollView.documentView = textView
        controller.attach(textView)
        context.coordinator.attach(textView)
        DispatchQueue.main.async {
            context.coordinator.reportContentHeight(of: textView)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? ComposerSubmitTextView else {
            return
        }
        context.coordinator.update(
            controller: controller,
            onFocusChange: onFocusChange,
            onSendableTextChange: onSendableTextChange,
            onContentHeightChange: onContentHeightChange,
            onMentionQueryChange: onMentionQueryChange,
            onMentionAnchorChange: onMentionAnchorChange,
            onMentionCommand: onMentionCommand,
            onSubmit: onSubmit
        )
        textView.placeholder = placeholder
        textView.font = font
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        textView.onFocusChange = onFocusChange
        textView.onSubmit = context.coordinator.submit
        textView.onPasteImages = onPasteImages
        textView.onMentionCommand = onMentionCommand
        controller.attach(textView)
        DispatchQueue.main.async {
            context.coordinator.reportContentHeight(of: textView)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            controller: controller,
            onFocusChange: onFocusChange,
            onSendableTextChange: onSendableTextChange,
            onContentHeightChange: onContentHeightChange,
            onMentionQueryChange: onMentionQueryChange,
            onMentionAnchorChange: onMentionAnchorChange,
            onMentionCommand: onMentionCommand,
            onSubmit: onSubmit
        )
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        private var controller: ComposerEditorController
        private var onFocusChange: (Bool) -> Void
        private var onSendableTextChange: (Bool) -> Void
        private var onContentHeightChange: (CGFloat) -> Void
        private var onMentionQueryChange: (ComposerMentionQuery?) -> Void
        private var onMentionAnchorChange: (UnitPoint) -> Void
        private var onMentionCommand: (ComposerMentionCommand) -> Bool
        private var onSubmit: (ComposerDraftBuffer.Submission) -> Void
        private var lastSendableState: Bool

        init(
            controller: ComposerEditorController,
            onFocusChange: @escaping (Bool) -> Void,
            onSendableTextChange: @escaping (Bool) -> Void,
            onContentHeightChange: @escaping (CGFloat) -> Void,
            onMentionQueryChange: @escaping (ComposerMentionQuery?) -> Void,
            onMentionAnchorChange: @escaping (UnitPoint) -> Void,
            onMentionCommand: @escaping (ComposerMentionCommand) -> Bool,
            onSubmit: @escaping (ComposerDraftBuffer.Submission) -> Void
        ) {
            self.controller = controller
            self.onFocusChange = onFocusChange
            self.onSendableTextChange = onSendableTextChange
            self.onContentHeightChange = onContentHeightChange
            self.onMentionQueryChange = onMentionQueryChange
            self.onMentionAnchorChange = onMentionAnchorChange
            self.onMentionCommand = onMentionCommand
            self.onSubmit = onSubmit
            lastSendableState = controller.draft.hasSendableText
        }

        func attach(_ textView: ComposerSubmitTextView) {
            textView.onFocusChange = onFocusChange
            textView.onSubmit = submit
            textView.onMentionCommand = onMentionCommand
        }

        func update(
            controller: ComposerEditorController,
            onFocusChange: @escaping (Bool) -> Void,
            onSendableTextChange: @escaping (Bool) -> Void,
            onContentHeightChange: @escaping (CGFloat) -> Void,
            onMentionQueryChange: @escaping (ComposerMentionQuery?) -> Void,
            onMentionAnchorChange: @escaping (UnitPoint) -> Void,
            onMentionCommand: @escaping (ComposerMentionCommand) -> Bool,
            onSubmit: @escaping (ComposerDraftBuffer.Submission) -> Void
        ) {
            self.controller = controller
            self.onFocusChange = onFocusChange
            self.onSendableTextChange = onSendableTextChange
            self.onContentHeightChange = onContentHeightChange
            self.onMentionQueryChange = onMentionQueryChange
            self.onMentionAnchorChange = onMentionAnchorChange
            self.onMentionCommand = onMentionCommand
            self.onSubmit = onSubmit
            lastSendableState = controller.draft.hasSendableText
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else {
                return
            }
            controller.recordEditorText(textView.string)
            reportMentionPresentation(of: textView)
            reportContentHeight(of: textView)
            let nextSendableState = controller.draft.hasSendableText
            guard nextSendableState != lastSendableState else {
                return
            }
            lastSendableState = nextSendableState
            onSendableTextChange(nextSendableState)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            reportMentionPresentation(of: textView)
        }

        private func reportMentionPresentation(of textView: NSTextView) {
            let query = ComposerMentionQuery.resolve(
                in: textView.string,
                selection: textView.selectedRange()
            )
            onMentionQueryChange(query)
            guard let query,
                  let anchor = mentionAnchorPoint(for: query, in: textView) else { return }
            onMentionAnchorChange(anchor)
        }

        private func mentionAnchorPoint(
            for query: ComposerMentionQuery,
            in textView: NSTextView
        ) -> UnitPoint? {
            guard let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer,
                  let scrollView = textView.enclosingScrollView,
                  query.replacementRange.location < textView.string.utf16.count else {
                return nil
            }
            let characterRange = NSRange(location: query.replacementRange.location, length: 1)
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: characterRange,
                actualCharacterRange: nil
            )
            layoutManager.ensureLayout(for: textContainer)
            var characterRect = layoutManager.boundingRect(
                forGlyphRange: glyphRange,
                in: textContainer
            )
            characterRect.origin.x += textView.textContainerOrigin.x
            characterRect.origin.y += textView.textContainerOrigin.y
            let viewportRect = textView.convert(characterRect, to: scrollView)
            return ComposerMentionAnchorPolicy.point(
                for: viewportRect,
                in: scrollView.bounds,
                viewportIsFlipped: scrollView.isFlipped
            )
        }

        func submit() {
            guard let submission = controller.submission() else {
                return
            }
            onSubmit(submission)
        }

        func reportContentHeight(of textView: NSTextView) {
            guard let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else {
                return
            }
            layoutManager.ensureLayout(for: textContainer)
            let usedHeight = layoutManager.usedRect(for: textContainer).height
            let contentHeight = usedHeight + (textView.textContainerInset.height * 2)
            onContentHeightChange(ComposerInputLayout.resolvedHeight(for: contentHeight))
        }
    }

    final class ComposerSubmitTextView: ComposerPasteTextView {
        var onSubmit: (() -> Void)?
        var onMentionCommand: ((ComposerMentionCommand) -> Bool)?
        var onFocusChange: ((Bool) -> Void)?
        var placeholder = "" {
            didSet {
                needsDisplay = true
            }
        }

        override func keyDown(with event: NSEvent) {
            if event.keyCode == 125, onMentionCommand?(.move(1)) == true { return }
            if event.keyCode == 126, onMentionCommand?(.move(-1)) == true { return }
            if event.keyCode == 53, onMentionCommand?(.dismiss) == true { return }
            let isReturn = event.keyCode == 36 || event.keyCode == 76
            let wantsNewline = event.modifierFlags.contains(.shift)
            if isReturn, hasMarkedText() {
                super.keyDown(with: event)
                return
            }
            if isReturn, !wantsNewline, onMentionCommand?(.select) == true { return }
            if isReturn && !wantsNewline {
                onSubmit?()
                return
            }
            super.keyDown(with: event)
        }

        override func becomeFirstResponder() -> Bool {
            let result = super.becomeFirstResponder()
            if result {
                onFocusChange?(true)
            }
            return result
        }

        override func resignFirstResponder() -> Bool {
            let result = super.resignFirstResponder()
            if result {
                onFocusChange?(false)
            }
            return result
        }

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            guard string.isEmpty, !placeholder.isEmpty else {
                return
            }
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font ?? NSFont.systemFont(ofSize: 12),
                .foregroundColor: NSColor.secondaryLabelColor
            ]
            let textSize = placeholder.size(withAttributes: attributes)
            let centeredY = max(0, (bounds.height - textSize.height) / 2)
            let origin = NSPoint(x: textContainerInset.width, y: centeredY)
            placeholder.draw(at: origin, withAttributes: attributes)
        }
    }
}

struct ChatInputTextView: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let font: NSFont
    var isEditable = true
    var autoFocus = false
    var textInsetHeight: CGFloat = 6
    var onFocusChange: (Bool) -> Void = { _ in }
    let onSubmit: () -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.onSubmit = onSubmit
        textView.onFocusChange = onFocusChange
        textView.placeholder = placeholder
        textView.font = font
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isEditable = isEditable
        textView.isSelectable = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.autoresizingMask = [.width]
        textView.string = text

        scrollView.documentView = textView
        context.coordinator.textView = textView

        if autoFocus {
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? SubmitTextView else {
            return
        }
        textView.onSubmit = onSubmit
        textView.onFocusChange = onFocusChange
        textView.placeholder = placeholder
        textView.font = font
        textView.isEditable = isEditable
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        if !textView.hasMarkedText(), textView.string != text {
            textView.string = text
        }
        if autoFocus, textView.window?.firstResponder !== textView {
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        weak var textView: SubmitTextView?

        init(text: Binding<String>) {
            _text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else {
                return
            }
            text = textView.string
        }
    }

    final class SubmitTextView: NSTextView {
        var onSubmit: (() -> Void)?
        var onFocusChange: ((Bool) -> Void)?
        var placeholder = "" {
            didSet {
                needsDisplay = true
            }
        }

        override func keyDown(with event: NSEvent) {
            let isReturn = event.keyCode == 36 || event.keyCode == 76
            let wantsNewline = event.modifierFlags.contains(.shift)
            if isReturn, hasMarkedText() {
                super.keyDown(with: event)
                return
            }
            if isReturn && !wantsNewline {
                onSubmit?()
                return
            }
            super.keyDown(with: event)
        }

        override func becomeFirstResponder() -> Bool {
            let result = super.becomeFirstResponder()
            if result {
                onFocusChange?(true)
            }
            return result
        }

        override func resignFirstResponder() -> Bool {
            let result = super.resignFirstResponder()
            if result {
                onFocusChange?(false)
            }
            return result
        }

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            guard string.isEmpty, !placeholder.isEmpty else {
                return
            }
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font ?? NSFont.systemFont(ofSize: 12),
                .foregroundColor: NSColor.secondaryLabelColor
            ]
            let textSize = placeholder.size(withAttributes: attributes)
            let centeredY = max(0, (bounds.height - textSize.height) / 2)
            let origin = NSPoint(x: textContainerInset.width, y: centeredY)
            placeholder.draw(at: origin, withAttributes: attributes)
        }
    }
}
