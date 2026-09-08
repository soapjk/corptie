import AppKit

/// Integrate attachments with AppKit's paste negotiation. Text remains plain
/// text; image data goes to the composer attachment importer, not text storage.
class ComposerPasteTextView: NSTextView {
    var onPasteImages: ((NSPasteboard) -> Bool)?

    private static let imagePasteTypes: [NSPasteboard.PasteboardType] =
        [.png, .tiff, .fileURL] + NSImage.imageTypes.map { NSPasteboard.PasteboardType($0) }

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        var types = super.readablePasteboardTypes
        for type in Self.imagePasteTypes where !types.contains(type) { types.append(type) }
        return types
    }

    func canImportImages(from pasteboard: NSPasteboard) -> Bool {
        // Metadata only: menu validation must not decode a screenshot or write
        // attachments, and must respect a non-editable input field.
        isEditable && onPasteImages != nil && pasteboard.availableType(from: Self.imagePasteTypes) != nil
    }

    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(NSText.paste(_:)), canImportImages(from: .general) { return true }
        return super.validateUserInterfaceItem(item)
    }

    override func preferredPasteboardType(from availableTypes: [NSPasteboard.PasteboardType],
        restrictedToTypesFrom allowedTypes: [NSPasteboard.PasteboardType]?) -> NSPasteboard.PasteboardType? {
        if isEditable, onPasteImages != nil,
           let type = Self.imagePasteTypes.first(where: {
               availableTypes.contains($0) && (allowedTypes == nil || allowedTypes!.contains($0))
           }) { return type }
        return super.preferredPasteboardType(from: availableTypes, restrictedToTypesFrom: allowedTypes)
    }

    override func readSelection(from pasteboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        if isEditable, Self.imagePasteTypes.contains(type), onPasteImages?(pasteboard) == true { return true }
        return super.readSelection(from: pasteboard, type: type)
    }
}
