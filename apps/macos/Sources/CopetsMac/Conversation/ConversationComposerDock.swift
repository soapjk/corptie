import SwiftUI

/// Quick actions now live in their own floating host. This dock owns only the
/// editor and its optional chrome, so it reserves no empty row above them.
struct ConversationComposerDock<QuickMessages: View, Composer: View>: View {
    let quickMessages: QuickMessages
    let composer: Composer

    init(@ViewBuilder quickMessages: () -> QuickMessages, @ViewBuilder composer: () -> Composer) {
        self.quickMessages = quickMessages()
        self.composer = composer()
    }

    var body: some View {
        VStack(spacing: 0) {
            quickMessages
            composer
        }
    }
}
