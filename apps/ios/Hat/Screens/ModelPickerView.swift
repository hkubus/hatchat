import HatKit
import SwiftUI

/// Model selection, as a sheet grouped by provider with a search field. The
/// grouping matters: ids are `provider/model`, and an ungrouped list of several
/// hundred OpenRouter entries is unusable.
struct ModelPickerView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var sections: [(provider: String, models: [ModelInfo])] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = needle.isEmpty ? store.models : store.models.filter {
            $0.id.lowercased().contains(needle) || $0.label.lowercased().contains(needle) || $0.provider.lowercased().contains(needle)
        }
        return Dictionary(grouping: filtered, by: \.provider)
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
            .map { ($0.key, $0.value) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.provider) { section in
                    Section(section.provider) {
                        ForEach(section.models) { model in
                            Button {
                                Haptics.selection()
                                store.setModel(model.id)
                                dismiss()
                            } label: {
                                row(model)
                            }
                            .foregroundStyle(.primary)
                            .accessibilityAddTraits(model.id == store.model ? .isSelected : [])
                        }
                    }
                }
            }
            .overlay {
                if sections.isEmpty {
                    if query.isEmpty {
                        ContentUnavailableView("No Models", systemImage: "cpu", description: Text("This server reports no models."))
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Models")
            .textInputAutocapitalization(.never)
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func row(_ model: ModelInfo) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(model.label).lineLimit(1)
                let tags = capTags(model.capabilities, contextWindow: model.contextWindow)
                if !tags.isEmpty {
                    FlowLayout(spacing: 5) {
                        ForEach(tags) { Badge(label: $0.label).accessibilityHint($0.title) }
                    }
                }
            }
            Spacer(minLength: 0)
            if model.id == store.model {
                Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Theme.accent)
            }
        }
        .contentShape(.rect)
    }
}
