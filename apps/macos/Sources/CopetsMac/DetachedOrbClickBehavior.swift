enum DetachedOrbClickAction: Equatable {
    case none
    case primary
    case openSession
}

enum DetachedOrbClickBehavior {
    static func action(clickCount: Int, didDrag: Bool) -> DetachedOrbClickAction {
        guard !didDrag else {
            return .none
        }
        if clickCount >= 2 {
            return .openSession
        }
        return clickCount == 1 ? .primary : .none
    }
}
