import SwiftUI

/// Quick actions and the editor share one SDK layout and fixed spacing.
struct ConversationComposerDock<QuickMessages: View, Composer: View>: View {
    let quickMessages: QuickMessages
    let composer: Composer

    init(@ViewBuilder quickMessages: () -> QuickMessages, @ViewBuilder composer: () -> Composer) {
        self.quickMessages = quickMessages()
        self.composer = composer()
    }

    var body: some View {
        VStack(spacing: 4) {
            quickMessages
            composer
        }
        .padding(.bottom, 4)
    }
}
