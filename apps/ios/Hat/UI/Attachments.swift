import HatKit
import QuickLook
import SwiftUI
import UIKit

/// Loads the pixels behind a `UiImage`. A stored attachment has to be fetched
/// with the bearer token, so it cannot be handed to `AsyncImage`; data URLs
/// and local previews are decoded in place. Decoded images are cached by
/// attachment id, since attachments are immutable.
@MainActor
enum ImageLoader {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    static func cached(_ image: UiImage) -> UIImage? {
        cache.object(forKey: key(image) as NSString)
    }

    static func load(_ image: UiImage, client: HatClient) async throws -> UIImage {
        let key = key(image)
        if let hit = cache.object(forKey: key as NSString) { return hit }
        let data: Data
        if let id = image.attachmentId, image.src.isEmpty {
            data = try await client.attachment(id: id).data
        } else if image.src.hasPrefix("data:"), let comma = image.src.firstIndex(of: ",") {
            data = Data(base64Encoded: String(image.src[image.src.index(after: comma)...])) ?? Data()
        } else if let url = URL(string: image.src) {
            data = try await URLSession.shared.data(from: url).0
        } else {
            data = Data()
        }
        guard let decoded = UIImage(data: data) else { throw HatError("That image could not be read.") }
        cache.setObject(decoded, forKey: key as NSString, cost: data.count)
        return decoded
    }

    private static func key(_ image: UiImage) -> String {
        if let id = image.attachmentId { return "att:" + id }
        // Data URLs can be megabytes; their length and ends identify them well enough.
        return "src:\(image.src.count):\(image.src.prefix(64)):\(image.src.suffix(64))"
    }
}

/// An image from a message or a tool result; tap to open the viewer.
struct MessageImage: View {
    enum Style { case thumbnail, fullWidth }

    var image: UiImage
    var style: Style
    var onOpen: (UIImage) -> Void

    @Environment(ChatStore.self) private var store
    @State private var loaded: UIImage?
    @State private var failed = false

    var body: some View {
        Button {
            if let loaded { onOpen(loaded) }
        } label: {
            ZStack {
                Theme.surfaceAlt
                if let loaded {
                    Image(uiImage: loaded)
                        .resizable()
                        .aspectRatio(contentMode: style == .thumbnail ? .fill : .fit)
                } else if failed {
                    Image(systemName: "photo.badge.exclamationmark").foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .frame(width: style == .thumbnail ? 120 : nil, height: style == .thumbnail ? 120 : nil)
            .aspectRatio(style == .fullWidth ? aspect : nil, contentMode: .fit)
            .frame(maxWidth: style == .fullWidth ? .infinity : nil, maxHeight: style == .fullWidth ? 420 : nil)
            .clipShape(.rect(cornerRadius: style == .thumbnail ? 14 : 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(loaded == nil)
        .accessibilityLabel("Open image")
        .task(id: image) {
            if let hit = ImageLoader.cached(image) {
                loaded = hit
                return
            }
            do {
                loaded = try await ImageLoader.load(image, client: store.client)
            } catch {
                failed = !isCancellation(error)
            }
        }
    }

    private var aspect: CGFloat {
        guard let size = loaded?.size, size.height > 0 else { return 4 / 3 }
        return size.width / size.height
    }
}

/// Full screen, pinch or double-tap to zoom, drag to pan.
struct ImageViewer: View {
    var image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(scale)
                .offset(offset)
                .gesture(
                    MagnifyGesture()
                        .onChanged { scale = max(1, settledScale * $0.magnification) }
                        .onEnded { _ in
                            settledScale = scale
                            if scale == 1 { resetPan() }
                        }
                        .simultaneously(with: DragGesture()
                            .onChanged { value in
                                guard scale > 1 else { return }
                                offset = CGSize(
                                    width: settledOffset.width + value.translation.width,
                                    height: settledOffset.height + value.translation.height
                                )
                            }
                            .onEnded { _ in settledOffset = offset })
                )
                .onTapGesture(count: 2) {
                    withAnimation(.snappy) {
                        scale = scale > 1 ? 1 : 2.5
                        settledScale = scale
                        if scale == 1 { resetPan() }
                    }
                }
                .ignoresSafeArea()
                .accessibilityLabel("Image")

            HStack(spacing: 12) {
                Button {
                    ShareSheet.present([image])
                } label: {
                    Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Share")
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Close")
            }
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .buttonStyle(.plain)
            .glass(in: .capsule, interactive: true)
            .padding()
        }
        .preferredColorScheme(.dark)
    }

    private func resetPan() {
        offset = .zero
        settledOffset = .zero
    }
}

/// A stored file: an artifact the assistant produced, or a document the user
/// attached. Tapping downloads it with the bearer token into a temporary file
/// named as the assistant named it, and opens it in Quick Look, which has
/// Share, Save to Files and Markup built in.
struct FileCard: View {
    var file: UiFile

    @Environment(ChatStore.self) private var store
    @State private var loading = false
    @State private var failed = false
    @State private var preview: URL?

    /// A document on the optimistic user message is not on the server yet.
    private var pending: Bool { file.id.hasPrefix(localPrefix) }

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(failed ? "Couldn’t open — tap to retry" : meta)
                        .font(.footnote)
                        .foregroundStyle(failed ? Theme.danger : .secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if loading || pending {
                    ProgressView()
                } else {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(12)
            .background(Theme.surfaceAlt, in: .rect(cornerRadius: 12, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(loading || pending)
        .accessibilityLabel("Open \(file.name)")
        .quickLookPreview($preview)
    }

    private var meta: String {
        [file.size > 0 ? formatBytes(file.size) : "", file.mime].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var icon: String {
        if file.mime.hasPrefix("image/") { return "photo" }
        if file.mime == "application/pdf" { return "doc.richtext" }
        if file.mime.hasPrefix("text/") || file.mime.contains("json") { return "doc.text" }
        return "doc"
    }

    private func open() async {
        loading = true
        failed = false
        defer { loading = false }
        do {
            let (data, _) = try await store.client.attachment(id: file.id)
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(file.id, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = file.name.replacingOccurrences(of: "/", with: "_")
            let url = folder.appendingPathComponent(name.isEmpty ? "file" : name)
            try data.write(to: url, options: .atomic)
            preview = url
        } catch {
            Haptics.error()
            failed = true
        }
    }
}

/// The system camera. `PhotosPicker` covers the library without any
/// permission prompt; the camera still needs `UIImagePickerController`.
struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
