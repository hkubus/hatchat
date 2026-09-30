import SwiftUI
import UIKit

/// Colours are the system's own semantic colours, so the app follows light and
/// dark mode, Increase Contrast and the grouped/plain distinction without a
/// palette of its own. The one exception is the tint, hat's red.
enum Theme {
    static let accent = Color("AccentColor")
    static let userBubble = Color(uiColor: .secondarySystemFill)
    static let surfaceAlt = Color(uiColor: .secondarySystemBackground)
    static let warn = Color.orange
    static let danger = Color.red
    static let success = Color.green

    /// At or above this share of the context window, the readout turns orange.
    static let contextWarn = 0.8
}

/// Haptic feedback, named for why it fires rather than which generator it
/// uses, so every screen gives the same feel for the same kind of moment.
@MainActor
enum Haptics {
    /// A button that commits something small: send, attach.
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// A value changed in a picker or menu.
    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    /// Something finished well: a reply landed, a key was saved, a copy happened.
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Needs attention: a tool waits for approval, or a destructive action.
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}
