import Foundation
import SwiftUI
import CorptieConversation

// The avatar palette, initials, squircle geometry and the objective avatar body
// live in CorptieConversation so iPad renders the same Work/Agent identity.
// macOS only injects its file-path image leaf.
typealias DefaultAvatarGradientStyle = CorptieConversation.DefaultAvatarGradientStyle
typealias DefaultAvatarInitials = CorptieConversation.DefaultAvatarInitials
typealias DefaultInitialAvatarView = CorptieConversation.DefaultInitialAvatarView
typealias MacOSAppIconGeometry = CorptieConversation.MacOSAppIconGeometry
typealias MacOSAppIconShape = CorptieConversation.MacOSAppIconShape
typealias ObjectiveAvatarGeometry = CorptieConversation.ObjectiveAvatarGeometry

struct ObjectiveAvatarView: View {
    let objectiveID: String
    let name: String
    let avatarPath: String?
    let size: CGFloat

    var body: some View {
        let picture: AnimatedAvatarImage? = (avatarPath?.isEmpty == false) ? AnimatedAvatarImage(path: avatarPath!) : nil
        CorptieConversation.ObjectiveAvatarView(objectiveID: objectiveID, name: name, size: size, picture: picture)
    }
}
