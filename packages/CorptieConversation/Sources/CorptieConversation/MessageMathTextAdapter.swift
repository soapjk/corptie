import Foundation
import SwiftMath

/// Formula-local protection for text the upstream parser otherwise silently
/// skips. No custom symbols or user text enter SwiftMath's global dictionaries.
@MainActor
enum MessageMathTextAdapter {
    struct Prepared {
        let list: MTMathList
        let textRuns: [String]
        let prototype: MTMathAtom?
        func copyList() -> MTMathList { MTMathList(atoms: list.atoms.map { $0.copy() }) }
    }

    static func prepare(_ latex: String) -> Prepared? {
        guard latex.utf16.count <= 8192 else { return nil }
        var prefix = "CORPTIEMATHTEXT"
        while latex.contains(prefix), prefix.count < 128 { prefix += "Z" }
        guard !latex.contains(prefix) else { return nil }
        var protected = ""
        var texts: [String] = []
        var markers: [String: Int] = [:]
        var index = latex.startIndex
        var depth = 0
        while index < latex.endIndex {
            let character = latex[index]
            if character == "\\" {
                protected.append(character)
                index = latex.index(after: index)
                guard index < latex.endIndex else { return nil }
                // Command names are not text islands. Preserve escapes exactly.
                if latex[index].isLetter {
                    repeat {
                        guard latex[index].isASCII else { return nil }
                        protected.append(latex[index]); index = latex.index(after: index)
                    } while index < latex.endIndex && latex[index].isLetter
                } else {
                    guard latex[index].isASCII else { return nil }
                    protected.append(latex[index]); index = latex.index(after: index)
                }
                continue
            }
            if isCJK(character) {
                let start = index
                repeat { index = latex.index(after: index) }
                    while index < latex.endIndex && isCJK(latex[index])
                guard texts.count < 128 else { return nil }
                let slot = texts.count
                let suffix = String(UnicodeScalar(65 + slot / 26)!) + String(UnicodeScalar(65 + slot % 26)!)
                let marker = prefix + suffix + "END"
                markers[marker] = slot
                texts.append(String(latex[start..<index]))
                protected += #"\mathrm{"# + marker + "}"
                continue
            }
            if character == "{" { depth += 1; if depth > 64 { return nil } }
            if character == "}" { depth -= 1; if depth < 0 { return nil } }
            // These characters are discarded by the upstream parser rather
            // than reported as errors. An unsupported literal must stay source.
            if "$%#~'".contains(character) { return nil }
            if !character.isASCII && MTMathAtomFactory.atom(forCharacter: character) == nil { return nil }
            if character.unicodeScalars.contains(where: { $0.value < 32 }) && !character.isWhitespace { return nil }
            protected.append(character)
            index = latex.index(after: index)
        }
        guard depth == 0, protected.utf16.count <= 16384 else { return nil }
        var error: NSError?
        guard let list = MTMathListBuilder.build(fromString: protected, error: &error), error == nil else { return nil }
        guard !texts.isEmpty else { return Prepared(list: list, textRuns: [], prototype: nil) }

        let markerLength = prefix.count + 5
        var consumed = Set<Int>()
        var prototype: MTMathAtom?
        var budget = 20000
        func restore(_ list: MTMathList, depth: Int) -> Bool {
            guard depth <= 64 else { return false }
            var restored: [MTMathAtom] = []
            var position = 0
            while position < list.atoms.count {
                budget -= 1
                guard budget >= 0 else { return false }
                var atom = list.atoms[position]
                if atom.nucleus == String(prefix.first!), position + markerLength <= list.atoms.count {
                    let candidate = Array(list.atoms[position..<(position + markerLength)])
                    let key = candidate.map(\.nucleus).joined()
                    if let slot = markers[key] {
                        guard candidate.allSatisfy({ $0.nucleus.count == 1 }),
                              candidate.dropLast().allSatisfy({ $0.subScript == nil && $0.superScript == nil }),
                              consumed.insert(slot).inserted, let last = candidate.last else { return false }
                        atom = atom.copy()
                        atom.type = .ordinary
                        atom.nucleus = texts[slot]
                        atom.subScript = last.subScript
                        atom.superScript = last.superScript
                        atom.indexRange = NSRange(location: 0, length: 0)
                        prototype = prototype ?? atom.copy()
                        position += markerLength
                    } else { position += 1 }
                } else { position += 1 }
                for child in children(of: atom) {
                    guard restore(child, depth: depth + 1) else { return false }
                }
                // CJK attached to glyph-level accents/boundaries needs separate
                // support; do not silently treat a missing math-font glyph as valid.
                if atom is MTAccent, texts.contains(where: { containsText(atom, $0) }) { return false }
                restored.append(atom)
            }
            list.atoms = restored
            return true
        }
        guard restore(list, depth: 0), consumed.count == texts.count else { return nil }
        return Prepared(list: list, textRuns: texts, prototype: prototype)
    }

    static func children(of atom: MTMathAtom) -> [MTMathList] {
        var lists = [atom.subScript, atom.superScript].compactMap { $0 }
        switch atom {
        case let value as MTFraction: lists += [value.numerator, value.denominator].compactMap { $0 }
        case let value as MTRadical: lists += [value.degree, value.radicand].compactMap { $0 }
        case let value as MTInner: if let child = value.innerList { lists.append(child) }
        case let value as MTOverLine: if let child = value.innerList { lists.append(child) }
        case let value as MTUnderLine: if let child = value.innerList { lists.append(child) }
        case let value as MTAccent: if let child = value.innerList { lists.append(child) }
        case let value as MTMathColor: if let child = value.innerList { lists.append(child) }
        case let value as MTMathTextColor: if let child = value.innerList { lists.append(child) }
        case let value as MTMathColorbox: if let child = value.innerList { lists.append(child) }
        case let value as MTMathTable: lists += value.cells.flatMap { $0 }
        default: break
        }
        return lists
    }

    private static func containsText(_ atom: MTMathAtom, _ text: String) -> Bool {
        atom.nucleus.contains(text) || children(of: atom).contains { $0.atoms.contains { containsText($0, text) } }
    }

    private static func isCJK(_ character: Character) -> Bool {
        guard character.unicodeScalars.count == 1, let value = character.unicodeScalars.first?.value else { return false }
        return (0x3400...0x9fff).contains(value) || (0xf900...0xfaff).contains(value)
            || (0x20000...0x323af).contains(value) || (0x3000...0x303f).contains(value)
            || (0xff01...0xff60).contains(value)
    }
}

private extension Character {
    var isASCII: Bool { unicodeScalars.allSatisfy { $0.value < 128 } }
}
