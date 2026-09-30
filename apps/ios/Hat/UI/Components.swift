import SwiftUI
import UIKit

/// An inline notice: an error, a warning, or a confirmation.
struct Banner: View {
    enum Tone { case error, warn, info }

    var tone: Tone
    var title: String
    var detail: String?
    var onDismiss: (() -> Void)?

    private var color: Color {
        switch tone {
        case .error: Theme.danger
        case .warn: Theme.warn
        case .info: Theme.accent
        }
    }

    private var icon: String {
        switch tone {
        case .error: "exclamationmark.octagon.fill"
        case .warn: "exclamationmark.triangle.fill"
        case .info: "checkmark.circle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .font(.subheadline)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
            if let onDismiss {
                Button {
                    onDismiss()
                } label: {
                    Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.12), in: .rect(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// A small capsule label: a tool's status, a model capability.
struct Badge: View {
    enum Tone { case neutral, good, warn, bad }

    var label: String
    var tone: Tone = .neutral

    private var color: Color {
        switch tone {
        case .neutral: .secondary
        case .good: Theme.success
        case .warn: Theme.warn
        case .bad: Theme.danger
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: .capsule)
    }
}

/// Monospaced text for tool arguments, output and reasoning.
struct Mono: View {
    var text: String
    var lineLimit: Int?
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(color)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Present the system share sheet over whatever is on screen. Presented from
/// UIKit rather than wrapped in a SwiftUI sheet, so it looks and sizes the way
/// it does everywhere else in iOS.
@MainActor
enum ShareSheet {
    static func present(_ items: [Any]) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.keyWindow?.rootViewController
        else { return }
        while let presented = top.presentedViewController { top = presented }
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // iPad presents it as a popover, which needs an anchor.
        controller.popoverPresentationController?.sourceView = top.view
        controller.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        controller.popoverPresentationController?.permittedArrowDirections = []
        top.present(controller, animated: true)
    }
}

/// A message's text with real selection handles. A long press in the
/// transcript opens the context menu, so partial selection can't live there.
struct SelectTextSheet: View {
    var text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableText(text: text)
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

private struct SelectableText: UIViewRepresentable {
    var text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
        view.backgroundColor = .systemBackground
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

/// A piece of text to present in a sheet (`sheet(item:)` needs an identity).
struct TextItem: Identifiable {
    let id = UUID()
    var text: String
}
