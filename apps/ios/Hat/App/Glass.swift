import SwiftUI

/// Liquid Glass for the controls that float over content — the composer, the
/// approval and edit panels, the jump-to-latest button — which is where the
/// HIG puts it. Content stays solid.
///
/// The system bars, toolbar buttons, menus, sheets and search field get Liquid
/// Glass from the system when the app is built with the iOS 26 SDK; nothing
/// here draws them. Below iOS 26 these surfaces fall back to a material.
extension View {
    @ViewBuilder
    func glass(in shape: some Shape, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
        }
    }
}

/// Lets neighbouring glass shapes blend into one another, as the composer's
/// attach button and input capsule do.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

enum GlassSupport {
    /// Whether this device renders Liquid Glass, for the Settings readout.
    static var isAvailable: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }
}
