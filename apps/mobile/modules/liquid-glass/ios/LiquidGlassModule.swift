import ExpoModulesCore
import UIKit

/// A view whose backing is Apple's real `UIGlassEffect` on iOS 26+, and a plain
/// `systemMaterial` blur everywhere else.
///
/// `UIGlassEffect` only exists in the iOS 26 SDK, so this file has to be
/// compiled with Xcode 26 or newer. It is written so the iOS 26 API is reached
/// only through an `#available` check, which is what keeps the module building
/// against older SDKs too — the older build simply never takes that branch.
final class GlassView: ExpoView {
  private let backdrop = UIVisualEffectView(effect: nil)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backdrop.translatesAutoresizingMaskIntoConstraints = false
    // The blur is decorative: it must never swallow touches meant for the
    // controls layered on top of it.
    backdrop.isUserInteractionEnabled = false
    addSubview(backdrop)

    NSLayoutConstraint.activate([
      backdrop.leadingAnchor.constraint(equalTo: leadingAnchor),
      backdrop.trailingAnchor.constraint(equalTo: trailingAnchor),
      backdrop.topAnchor.constraint(equalTo: topAnchor),
      backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    applyEffect()
  }

  private func applyEffect() {
    if #available(iOS 26.0, *) {
      // `clear` drops the tint so only the distortion remains, which is what
      // you want behind text-heavy chrome. The style is fixed at init time, so
      // a variant change has to build a new effect rather than mutate one.
      let style: UIGlassEffect.Style = variant == 1 ? .clear : .regular
      backdrop.effect = UIGlassEffect(style: style)
    } else {
      backdrop.effect = UIBlurEffect(style: .systemMaterial)
    }
  }

  /// Maps to the `variant` prop on the JS side: 0 regular, 1 clear. The prop
  /// itself is declared by the `Prop` block in the module definition below.
  var variant: Int = 0 {
    didSet { applyEffect() }
  }
}

public final class LiquidGlassModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiquidGlass")

    View(GlassView.self) {
      Events("onTap")

      Prop("variant") { (view: GlassView, value: Int) in
        view.variant = value
      }
    }
  }
}
