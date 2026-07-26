enum DetachedOrbClickAction: Equatable {
    case none
    case schedulePrimary
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
        return clickCount == 1 ? .schedulePrimary : .none
    }
}
