import HatKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The conversation: transcript under the navigation bar, a floating Liquid
/// Glass composer at the bottom.
///
/// The bar's title shows the conversation and its model, and opens the model
/// sheet; the conversation's options (reasoning effort, tool approval, model,
/// instructions and sampling, export, usage) are a pull-down menu on a bar
/// button. The composer rides the keyboard through `safeAreaInset`, and the
/// transcript scrolls underneath it, dismissing the keyboard interactively.
struct ChatScreen: View {
    @Environment(ChatStore.self) private var store
    @Binding var selection: String?

    @State private var draft = ""
    @State private var attachments: [PendingAttachment] = []
    @State private var editingId: String?
    @State private var editingText = ""
    @State private var nearBottom = true
    @State private var awayFromBottom = false
    @State private var selecting: TextItem?
    @State private var viewing: ViewedImage?
    @State private var showModel = false
    @State private var showConversation = false
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var picking = false
    @FocusState private var composerFocused: Bool

    private static let bottomID = "bottom"
    /// How close to the bottom the list has to be to keep following the stream.
    private static let nearBottomDistance: CGFloat = 96

    private var rows: [UiMessage] { store.messages + store.inFlight }
    /// A draft a send gave back (refused, or a file rejected), once the
    /// conversation it was written in is the one open here. Never another's:
    /// switching away before the refusal arrives leaves it waiting for this one.
    private var unsentDraftHere: UnsentDraft? {
        guard let id = selection, store.sessionId == id else { return nil }
        return store.unsentDrafts[id]
    }
    private var canSend: Bool {
        !store.busy && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    var body: some View {
        Group {
            if store.sessionId == selection {
                transcript
            } else if let error = store.error {
                ContentUnavailableView("Couldn’t Open", systemImage: "exclamationmark.bubble", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(store.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .sheet(isPresented: $showModel) { ModelPickerView() }
        .sheet(isPresented: $showConversation) {
            NavigationStack { ConversationSettingsView(asSheet: true) }
        }
        .sheet(item: $selecting) { SelectTextSheet(text: $0.text) }
        .fullScreenCover(item: $viewing) { ImageViewer(image: $0.image) }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { addCameraImage($0) }.ignoresSafeArea()
        }
        .photosPicker(
            isPresented: $showPhotos,
            selection: $photoItems,
            maxSelectionCount: 10,
            matching: .images,
            // Ask for the compatible (JPEG) representation of HEIC photos.
            preferredItemEncoding: .compatible
        )
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            addFiles(result)
        }
        // Feedback for things that happen without a tap.
        .onChange(of: store.pendingApproval?.callId) { _, id in if id != nil { Haptics.warning() } }
        .onChange(of: store.pendingQuestionId) { _, id in if id != nil { Haptics.warning() } }
        .onChange(of: store.busy) { was, now in if was && !now && store.error == nil { Haptics.success() } }
        .onChange(of: store.error) { _, error in if error != nil { Haptics.error() } }
        .onChange(of: unsentDraftHere, initial: true) { _, unsent in
            if unsent != nil { restoreUnsentDraft() }
        }
    }

    /// Put an unsent draft back in the composer, keeping whatever has been
    /// written since: the user's own text, or attachments, win over the draft's.
    private func restoreUnsentDraft() {
        guard let id = selection, store.sessionId == id, let unsent = store.takeUnsentDraft(for: id) else { return }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !unsent.text.isEmpty { draft = unsent.text }
        if attachments.isEmpty { attachments = unsent.attachments }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(rows) { message in
                        MessageRow(message: message, busy: store.busy, actions: actions)
                            .id(message.id)
                    }
                    footer
                    Color.clear.frame(height: 1).id(ChatScreen.bottomID)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY
            } action: { _, distance in
                // Follow the stream only while the reader is at the bottom, so
                // scrolling up to re-read is not fought by every delta.
                nearBottom = distance < ChatScreen.nearBottomDistance
                awayFromBottom = distance > ChatScreen.nearBottomDistance * 3
            }
            .onChange(of: store.inFlight) {
                // Instant while streaming: an animated scroll per delta judders.
                if nearBottom { proxy.scrollTo(ChatScreen.bottomID, anchor: .bottom) }
            }
            .onChange(of: store.messages.count) {
                if nearBottom { withAnimation { proxy.scrollTo(ChatScreen.bottomID, anchor: .bottom) } }
            }
            .overlay {
                if rows.isEmpty {
                    if store.ready {
                        ContentUnavailableView(
                            "Start a Conversation",
                            systemImage: "bubble.left.and.text.bubble.right",
                            description: Text("Ask something, attach a document, or an image for a vision-capable model.")
                        )
                    } else {
                        ProgressView()
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composerDock(proxy)
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        VStack(spacing: 8) {
            // Directly under the reply it would extend, once nothing is running.
            if store.canContinue {
                HStack(spacing: 10) {
                    Text("The reply stopped at the length limit.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("Continue") {
                        Haptics.tap()
                        nearBottom = true
                        Task { await store.continueReply() }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                }
            }
            if let error = store.error {
                Banner(tone: .error, title: "Something went wrong", detail: error) { store.clearError() }
            }
            ForEach(Array(store.warnings.enumerated()), id: \.offset) { _, warning in
                Banner(tone: .warn, title: "Heads up", detail: warning)
            }
        }
        .padding(.top, 8)
    }

    private var actions: MessageActions {
        MessageActions(
            regenerate: { id in
                Haptics.tap()
                Task { await store.regenerate(id) }
            },
            edit: { id in
                editingText = store.messages.first { $0.id == id }?.text ?? ""
                editingId = id
            },
            fork: { id in
                Task {
                    do {
                        try await store.fork(at: id)
                        selection = store.sessionId
                        nearBottom = true
                        Haptics.success()
                    } catch {
                        store.report("Could not fork: \(describe(error))")
                    }
                }
            },
            switchBranch: { id in
                Haptics.selection()
                Task { await store.switchBranch(to: id) }
            },
            decide: decide,
            answer: { callId, answer in
                Haptics.tap()
                Task { await store.answer(callId, answer) }
            },
            selectText: { selecting = TextItem(text: $0) },
            openImage: { viewing = ViewedImage(image: $0) }
        )
    }

    private func decide(_ callId: String, _ decision: ApprovalDecision) {
        if decision == .deny { Haptics.warning() } else { Haptics.success() }
        Task { await store.decide(callId, decision) }
    }

    // MARK: Navigation bar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Button {
                showModel = true
            } label: {
                VStack(spacing: 0) {
                    Text(store.title)
                        .font(.headline)
                        .lineLimit(1)
                    HStack(spacing: 3) {
                        Text(store.selectedModel?.label ?? store.model).lineLimit(1)
                        if let fill = contextPercent {
                            Text("· \(fill)%")
                                .monospacedDigit()
                                .foregroundStyle((store.contextUsage?.fraction ?? 0) >= Theme.contextWarn ? Theme.warn : Color.secondary)
                        }
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                    }
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 240)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(titleAccessibilityLabel)
        }
        ToolbarItem(placement: .topBarTrailing) { optionsMenu }
        ToolbarItem(placement: .topBarTrailing) {
            Button("New Chat", systemImage: "square.and.pencil") {
                Haptics.tap()
                Task {
                    do {
                        try await store.newChat()
                        selection = store.sessionId
                    } catch {
                        store.report(describe(error))
                    }
                }
            }
        }
    }

    private var titleAccessibilityLabel: String {
        let model = store.selectedModel?.label ?? store.model
        let context = contextPercent.map { " Context \($0) percent full." } ?? ""
        return "\(store.title). Model: \(model).\(context) Change model"
    }

    private var contextPercent: Int? {
        store.contextUsage.map { Int(($0.fraction * 100).rounded()) }
    }

    private var optionsMenu: some View {
        Menu {
            if store.selectedModel?.capabilities.reasoningEffort == true {
                Menu {
                    ForEach(ReasoningEffort.allCases, id: \.self) { effort in
                        Toggle(effort.label, isOn: Binding(
                            get: { store.reasoningEffort == effort },
                            set: { _ in
                                Haptics.selection()
                                store.setEffort(effort)
                            }
                        ))
                    }
                } label: {
                    Label("Reasoning", systemImage: "brain")
                    Text(store.reasoningEffort.label)
                }
            }
            Menu {
                ForEach(ApprovalMode.allCases, id: \.self) { mode in
                    Toggle(isOn: Binding(
                        get: { store.policyMode == mode },
                        set: { _ in
                            Haptics.selection()
                            store.setPolicyMode(mode)
                        }
                    )) {
                        Text(mode.label)
                        Text(mode.menuDescription)
                    }
                }
            } label: {
                Label("Tool Approval", systemImage: "hand.raised")
                Text(store.policyMode.label)
            }

            Button { showModel = true } label: {
                Label("Change Model…", systemImage: "cpu")
                if let model = store.selectedModel { Text(capSummary(model)) }
            }
            Button("Instructions & Sampling…", systemImage: "slider.horizontal.3") { showConversation = true }
            if store.sessionId != nil, !store.messages.isEmpty {
                Button("Export as Markdown…", systemImage: "square.and.arrow.up") {
                    Task { await exportMarkdown() }
                }
            }

            Section("Usage") {
                let tokens = formatTokens(usageTotal(store.sessionUsage))
                Button {} label: {
                    Label(tokens.isEmpty ? "No usage yet" : "\(tokens) tokens", systemImage: "chart.bar")
                    if !tokens.isEmpty { Text(usageDetail(store.sessionUsage)) }
                }
                .disabled(true)
                if let usage = store.contextUsage, let percent = contextPercent {
                    Button {} label: {
                        Label("Context \(percent)% full", systemImage: "gauge.with.dots.needle.33percent")
                        Text("\(formatTokens(usage.tokens)) of \(formatTokens(usage.window)) context")
                    }
                    .disabled(true)
                }
            }
        } label: {
            Label("Conversation Options", systemImage: "ellipsis")
        }
    }

    private func exportMarkdown() async {
        guard let id = store.sessionId else { return }
        do {
            // Plain text: the share sheet offers Copy, Notes, Mail and Save to Files.
            let markdown = try await store.client.exportMarkdown(id: id)
            ShareSheet.present([markdown])
        } catch {
            store.report("Could not export: \(describe(error))")
        }
    }

    // MARK: Composer

    private func composerDock(_ proxy: ScrollViewProxy) -> some View {
        let approval = store.pendingApproval
        return VStack(spacing: 8) {
            if awayFromBottom && editingId == nil && approval == nil {
                Button {
                    Haptics.tap()
                    nearBottom = true
                    withAnimation { proxy.scrollTo(ChatScreen.bottomID, anchor: .bottom) }
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .glass(in: .circle, interactive: true)
                .accessibilityLabel("Scroll to latest message")
                .transition(.scale.combined(with: .opacity))
            }

            // An approval surfaces here, so it cannot be scrolled out of reach.
            if let approval {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.warn)
                        Text("\(approval.name) wants to run")
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                    let summary = toolSummary(approval)
                    if !summary.isEmpty { Mono(text: summary, lineLimit: 3) }
                    HStack(spacing: 8) {
                        Button(role: .destructive) { decide(approval.callId, .deny) } label: {
                            Text("Deny").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        Button { decide(approval.callId, .approve) } label: {
                            Text("Approve").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .buttonBorderShape(.capsule)
                }
                .padding(14)
                .glass(in: .rect(cornerRadius: 24, style: .continuous))
            }

            if editingId != nil {
                editPanel
            } else {
                if !attachments.isEmpty { attachmentTray }
                GlassGroup(spacing: 10) {
                    HStack(alignment: .bottom, spacing: 10) {
                        attachMenu
                        inputField
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .animation(.snappy, value: awayFromBottom)
        .animation(.snappy, value: approval?.callId)
    }

    private var editPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Editing Message", systemImage: "pencil")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.accent)
            TextField("Message", text: $editingText, axis: .vertical)
                .lineLimit(2...8)
                .focused($composerFocused)
            HStack {
                Spacer()
                Button("Cancel") {
                    editingId = nil
                    editingText = ""
                }
                .buttonStyle(.bordered)
                Button("Save & Resend") {
                    guard let id = editingId else { return }
                    let text = editingText
                    editingId = nil
                    editingText = ""
                    Haptics.tap()
                    nearBottom = true
                    Task { await store.editMessage(id, text: text) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(editingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy)
            }
            .buttonBorderShape(.capsule)
        }
        .padding(14)
        .glass(in: .rect(cornerRadius: 24, style: .continuous))
        .onAppear { composerFocused = true }
    }

    private var attachmentTray: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        if attachment.kind == .document {
                            HStack(spacing: 8) {
                                Image(systemName: "doc").foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(attachment.name).font(.footnote.weight(.semibold)).lineLimit(2)
                                    Text(formatBytes(attachment.data.count)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.horizontal, 10)
                            .frame(width: 176, height: 64, alignment: .leading)
                            .glass(in: .rect(cornerRadius: 14, style: .continuous))
                        } else if let image = UIImage(data: attachment.data) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 64, height: 64)
                                .clipShape(.rect(cornerRadius: 14, style: .continuous))
                                .accessibilityLabel(attachment.name)
                        }
                        Button {
                            Haptics.selection()
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 22, height: 22)
                                .background(.black.opacity(0.55), in: .circle)
                        }
                        .buttonStyle(.plain)
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                }
            }
            .padding(.top, 6)
            .padding(.trailing, 6)
        }
    }

    private var attachMenu: some View {
        Menu {
            Button("Camera", systemImage: "camera") {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    showCamera = true
                } else {
                    store.report("This device has no camera available.")
                }
            }
            Button("Photo Library", systemImage: "photo.on.rectangle") { showPhotos = true }
            Button { showFiles = true } label: {
                Label("Choose File", systemImage: "doc")
                Text("Text, code or PDF")
            }
        } label: {
            Group {
                if picking {
                    ProgressView()
                } else {
                    Image(systemName: "plus").font(.title3.weight(.medium))
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(.circle)
        }
        .foregroundStyle(.primary)
        .glass(in: .circle, interactive: true)
        .accessibilityLabel("Attach a photo or file")
    }

    private var inputField: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField(store.busy ? "Responding…" : "Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.vertical, 11)
            if store.busy {
                Button {
                    Haptics.tap()
                    store.stop()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .frame(width: 32, height: 32)
                        .background(Color.primary, in: .circle)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 6)
                .accessibilityLabel("Stop generating")
            } else if canSend {
                Button {
                    submit()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Theme.accent, in: .circle)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 6)
                .accessibilityLabel("Send message")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(minHeight: 44)
        .glass(in: .rect(cornerRadius: 22, style: .continuous))
    }

    private func submit() {
        guard canSend else { return }
        Haptics.tap()
        let text = draft
        let pending = attachments
        draft = ""
        attachments = []
        nearBottom = true
        Task { await store.send(text, attachments: pending) }
    }

    // MARK: Attachments

    /// A picked image as the server can read it: PNG, JPEG, GIF and WebP pass
    /// through; anything else (HEIC, mostly) is re-encoded as JPEG.
    private func imageAttachment(_ data: Data, name: String) -> PendingAttachment? {
        if let mime = sniffImageMime(data) {
            return PendingAttachment(data: data, name: name, mime: mime, kind: .image)
        }
        guard let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) else { return nil }
        let base = (name as NSString).deletingPathExtension
        return PendingAttachment(data: jpeg, name: "\(base).jpg", mime: "image/jpeg", kind: .image)
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        picking = true
        defer { picking = false }
        var added: [PendingAttachment] = []
        var failed = 0
        for (index, item) in items.enumerated() {
            let name = "image-\(Int(Date().timeIntervalSince1970))-\(index + 1)"
            if let data = try? await item.loadTransferable(type: Data.self), let attachment = imageAttachment(data, name: name) {
                added.append(attachment)
            } else {
                failed += 1
            }
        }
        if failed > 0 {
            store.report("Couldn’t read \(failed == 1 ? "one of the images" : "\(failed) images"). The server accepts PNG, JPEG, GIF, and WebP.")
        }
        if !added.isEmpty {
            Haptics.tap()
            attachments += added
        }
    }

    private func addCameraImage(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        Haptics.tap()
        attachments.append(PendingAttachment(data: data, name: "photo-\(Int(Date().timeIntervalSince1970)).jpg", mime: "image/jpeg", kind: .image))
    }

    /// Documents from Files: text, code and PDFs, which the server reads as
    /// text for the model. An image picked here is sent as an image. The server
    /// decides what it can read (a scanned PDF comes back with a reason), so
    /// only size and image format are checked here.
    private func addFiles(_ result: Result<[URL], Error>) {
        let urls: [URL]
        switch result {
        case let .success(picked): urls = picked
        case let .failure(error):
            store.report("Could not open the file: \(describe(error))")
            return
        }
        var accepted: [PendingAttachment] = []
        var problems: [String] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size > maxUploadBytes {
                problems.append("\(name) is larger than the server’s 25 MB limit.")
                continue
            }
            guard let data = try? Data(contentsOf: url) else {
                problems.append("\(name) could not be read.")
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)
            if type?.conforms(to: .image) == true {
                if let image = imageAttachment(data, name: name) {
                    accepted.append(image)
                } else {
                    problems.append("\(name) is not an image format the server can read.")
                }
            } else {
                let mime = type?.preferredMIMEType ?? "application/octet-stream"
                accepted.append(PendingAttachment(data: data, name: name, mime: mime, kind: .document))
            }
        }
        if !problems.isEmpty { store.report(problems.joined(separator: " ")) }
        if !accepted.isEmpty {
            Haptics.tap()
            attachments += accepted
        }
    }
}

/// An image opened full screen.
struct ViewedImage: Identifiable {
    let id = UUID()
    var image: UIImage
}

extension ApprovalMode {
    var menuDescription: String {
        switch self {
        case .ask: "Pause for approval"
        case .auto: "Run every tool"
        case .allowlist: "Ask unless allowlisted"
        case .deny: "Block all tools"
        }
    }
}
