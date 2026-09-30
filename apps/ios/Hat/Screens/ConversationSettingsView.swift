import HatKit
import SwiftUI

/// Instructions, temperature and the reply-token cap for one conversation,
/// stored on the server session (`PATCH /api/sessions/:id`).
///
/// Shown as a sheet over the chat (from the options menu) and pushed inside
/// the Settings sheet. Edits are held here and saved with the bar's Save
/// button, as in Contacts or Calendar; Cancel or Back discards them.
struct ConversationSettingsView: View {
    /// A sheet gets a Cancel button, since it has no Back.
    var asSheet: Bool

    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var instructions = ""
    @State private var temperature = ""
    @State private var maxTokens = ""
    @State private var initial = (instructions: "", temperature: "", maxTokens: "")
    @State private var loaded = false
    @State private var saving = false
    @State private var error: String?

    /// Mirrors the server's limit, so an over-long paste fails here, not on Save.
    private static let maxInstructions = 20_000

    var body: some View {
        let temperatureValue = parseTemperature(temperature)
        let maxTokensValue = parseMaxTokens(maxTokens)
        let tooLong = instructions.count > Self.maxInstructions
        let problem: String? = tooLong
            ? "Instructions are limited to \(groupedNumber(Self.maxInstructions)) characters."
            : temperatureValue.error ?? maxTokensValue.error
        let dirty = instructions.trimmingCharacters(in: .whitespacesAndNewlines) != initial.instructions
            || temperature.trimmingCharacters(in: .whitespaces) != initial.temperature
            || maxTokens.trimmingCharacters(in: .whitespaces) != initial.maxTokens

        Form {
            if let message = error ?? problem {
                Section {
                    Banner(tone: .error, title: error != nil ? "Could not save" : "Check this", detail: message)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                TextField("e.g. Answer in British English and keep it brief.", text: $instructions, axis: .vertical)
                    .lineLimit(5...14)
            } header: {
                Text("Instructions")
            } footer: {
                Text("Added to the system prompt for this conversation only. Use it for a persona, a language, or a house style.")
            }
            Section {
                LabeledContent("Temperature") {
                    TextField("Default", text: $temperature)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .foregroundStyle(temperatureValue.error == nil ? Color.secondary : Theme.danger)
                }
                LabeledContent("Max Reply Tokens") {
                    TextField("Default", text: $maxTokens)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .foregroundStyle(maxTokensValue.error == nil ? Color.secondary : Theme.danger)
                }
            } header: {
                Text("Sampling")
            } footer: {
                Text("Temperature runs from 0 (focused) to 2 (varied). Max reply tokens caps each model call; a reply cut off by it can be continued. Leave either empty for the model’s default.")
            }
            Section {
                Button("Reset to Defaults") {
                    Haptics.selection()
                    instructions = ""
                    temperature = ""
                    maxTokens = ""
                }
                .disabled(instructions.isEmpty && temperature.isEmpty && maxTokens.isEmpty)
            }
        }
        .navigationTitle("Instructions & Sampling")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if asSheet {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Save") {
                        Task { await save(temperatureValue.value, maxTokensValue.value) }
                    }
                    .disabled(!dirty || problem != nil)
                }
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        let session = store.session
        initial = (
            session?.instructions ?? "",
            session?.temperature.map { JSONValue.format($0) } ?? "",
            session?.maxTokens.map(String.init) ?? ""
        )
        instructions = initial.instructions
        temperature = initial.temperature
        maxTokens = initial.maxTokens
    }

    private func save(_ temperature: Double?, _ maxTokens: Int?) async {
        saving = true
        error = nil
        do {
            try await store.updateConversation(ConversationSettings(
                instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines),
                temperature: temperature,
                maxTokens: maxTokens
            ))
            Haptics.success()
            dismiss()
        } catch {
            Haptics.error()
            self.error = describe(error)
            saving = false
        }
    }

    /// "" is the provider default; a comma is accepted as the decimal separator.
    private func parseTemperature(_ text: String) -> (value: Double?, error: String?) {
        let trimmed = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        if trimmed.isEmpty { return (nil, nil) }
        guard let value = Double(trimmed), value.isFinite, (0...2).contains(value) else {
            return (nil, "Temperature must be a number from 0 to 2.")
        }
        return (value, nil)
    }

    private func parseMaxTokens(_ text: String) -> (value: Int?, error: String?) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return (nil, nil) }
        guard let value = Int(trimmed), value > 0 else {
            return (nil, "Max reply tokens must be a whole number above zero.")
        }
        return (value, nil)
    }
}
