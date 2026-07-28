enum DetachedSessionCloseBehavior {
    static func shouldCreateOrb(status: TaskStatus, isAlreadyFloating: Bool) -> Bool {
        status == .running && !isAlreadyFloating
    }
}
