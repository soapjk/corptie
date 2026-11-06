import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// An in-memory, Work-only payload; external text and Task drops cannot reorder Works.
struct ConsoleWorkOrderDragItem: Transferable, Sendable {
    let id: String
    static let typeIdentifier = "com.corptie.work-order"

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(contentType: UTType(exportedAs: typeIdentifier)) { item in
            Data(item.id.utf8)
        } importing: { data in
            guard let id = String(data: data, encoding: .utf8), !id.isEmpty else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return Self(id: id)
        }
    }
}
