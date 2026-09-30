import HatKit
import SwiftUI

private let keysFooter = "Keys are sent to the server and stored encrypted there. They never reach this device again."

struct ProvidersView: View {
    @Environment(ChatStore.self) private var store
    @State private var data = Loadable<[ProviderStatus]>()

    var body: some View {
        List {
            Notices(data: data, errorTitle: "Could not load providers")
            if let providers = data.value {
                if providers.isEmpty {
                    Banner(tone: .info, title: "This server exposes no key-backed providers.")
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(providers) { provider in
                            NavigationLink(value: SettingsRoute.provider(provider.id)) {
                                LabeledContent {
                                    Text(provider.configured ? "Set" : "Not Set")
                                } label: {
                                    Text(provider.label)
                                    Text(provider.secretName)
                                }
                            }
                        }
                    } footer: {
                        Text(keysFooter)
                    }
                }
            }
        }
        .navigationTitle("Providers")
        .task { await data.load { try await store.client.providers() } }
    }
}

struct ProviderView: View {
    var providerId: String
    @Environment(ChatStore.self) private var store
    @State private var data = Loadable<[ProviderStatus]>()
    @State private var key = ""
    @State private var busy = false
    @State private var confirmRemove = false

    private var provider: ProviderStatus? { data.value?.first { $0.id == providerId } }

    var body: some View {
        List {
            Notices(data: data)
            if let provider {
                Section("Status") {
                    LabeledContent("API Key", value: provider.configured ? "Set" : "Not Set")
                    LabeledContent("Provider", value: provider.registered ? "Registered" : "Not Registered")
                    if let status = provider.status { LabeledContent("Status", value: status) }
                }
                Section {
                    SecureField(provider.configured ? "New key" : "Paste key", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await save(provider) }
                    } label: {
                        HStack {
                            Text("Save")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                } header: {
                    Text(provider.configured ? "Replace Key" : "Set Key")
                } footer: {
                    Text("\(provider.secretName). \(keysFooter)")
                }
                if provider.configured {
                    Section {
                        Button("Remove Key", role: .destructive) {
                            Haptics.warning()
                            confirmRemove = true
                        }
                    }
                }
            } else if data.value != nil {
                Banner(tone: .warn, title: "Provider not found", detail: "The server no longer reports this provider.")
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(provider?.label ?? "")
        .task { await data.load { try await store.client.providers() } }
        .alert("Remove the \(provider?.label ?? "") key?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) {
                guard let provider else { return }
                Task {
                    await data.change("\(provider.label) key removed.") {
                        try await store.client.deleteSecret(name: provider.secretName)
                    } refetch: {
                        try await store.client.providers()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Models from this provider stop working until a new key is set.")
        }
    }

    private func save(_ provider: ProviderStatus) async {
        busy = true
        defer { busy = false }
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let saved = await data.change("\(provider.label) key saved.") {
            try await store.client.setSecret(name: provider.secretName, value: value)
        } refetch: {
            try await store.client.providers()
        }
        if saved { key = "" }
    }
}

struct PluginsView: View {
    @Environment(ChatStore.self) private var store
    @State private var data = Loadable<[PluginDescriptor]>()
    @State private var pending: [String: Bool] = [:]

    var body: some View {
        List {
            Notices(data: data)
            if let plugins = data.value {
                if plugins.isEmpty {
                    Banner(tone: .info, title: "This server has no plugins installed.")
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(plugins) { plugin in
                            row(plugin)
                        }
                    } footer: {
                        Text("Providers and tools are contributed by plugins on the server.")
                    }
                }
                // Plugins without a settings screen show their error only here.
                ForEach(plugins.filter { $0.error != nil }) { plugin in
                    Banner(tone: .error, title: plugin.name, detail: plugin.error)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .navigationTitle("Plugins")
        .task { await data.load { try await store.client.plugins() } }
    }

    @ViewBuilder
    private func row(_ plugin: PluginDescriptor) -> some View {
        let toggle = Toggle(isOn: Binding(
            get: { pending[plugin.id] ?? plugin.enabled },
            set: { next in Task { await setEnabled(plugin, next) } }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(plugin.name)
                    if plugin.status == "error" {
                        Badge(label: "Error", tone: .bad)
                    } else if plugin.status == "needs-config" {
                        Badge(label: "Needs Config", tone: .warn)
                    }
                }
                Text("\(plugin.id) v\(plugin.version) · \(plugin.source)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        if plugin.configSchema?.properties?.isEmpty == false {
            NavigationLink(value: SettingsRoute.plugin(plugin.id)) { toggle }
        } else {
            toggle
        }
    }

    private func setEnabled(_ plugin: PluginDescriptor, _ enabled: Bool) async {
        pending[plugin.id] = enabled
        await data.change("\(plugin.name) \(enabled ? "enabled" : "disabled").") {
            try await store.client.setPluginEnabled(id: plugin.id, enabled: enabled)
        } refetch: {
            try await store.client.plugins()
        }
        pending[plugin.id] = nil
    }
}

/// A plugin's settings, generated from its JSON schema: enums as pop-up
/// pickers, booleans as switches, strings and numbers as fields with Save.
struct PluginView: View {
    var pluginId: String
    @Environment(ChatStore.self) private var store
    @State private var data = Loadable<[PluginDescriptor]>()
    @State private var pending: [String: Bool] = [:]

    private var plugin: PluginDescriptor? { data.value?.first { $0.id == pluginId } }

    private enum Kind { case choice, flag, text, unsupported }

    private func kind(_ property: JsonSchemaProperty) -> Kind {
        if property.enum != nil { return .choice }
        if property.type == "boolean" { return .flag }
        if ["string", "number", "integer"].contains(property.type ?? "") { return .text }
        return .unsupported
    }

    var body: some View {
        List {
            Notices(data: data)
            if let plugin {
                if let error = plugin.error {
                    Banner(tone: .error, title: "Plugin error", detail: error).listRowBackground(Color.clear)
                }
                let fields = (plugin.configSchema?.properties ?? [:]).sorted { $0.key < $1.key }
                let options = fields.filter { kind($0.value) != .text }
                if !options.isEmpty {
                    Section {
                        ForEach(options, id: \.key) { field in
                            option(plugin, field.key, field.value)
                        }
                    } header: {
                        Text("Options")
                    } footer: {
                        if let description = plugin.description { Text(description) }
                    }
                }
                ForEach(fields.filter { kind($0.value) == .text }, id: \.key) { field in
                    Section {
                        PluginTextField(
                            name: field.key,
                            numeric: field.value.type != "string",
                            value: plugin.config[field.key]
                        ) { value in
                            await save(plugin, field.key, value)
                        }
                    } footer: {
                        if let description = field.value.description { Text(description) }
                    }
                }
                if fields.isEmpty {
                    Banner(tone: .info, title: "This plugin has no settings.").listRowBackground(Color.clear)
                }
            } else if data.value != nil {
                Banner(tone: .warn, title: "Plugin not found", detail: "The server no longer reports this plugin.")
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(plugin?.name ?? "")
        .task { await data.load { try await store.client.plugins() } }
    }

    @ViewBuilder
    private func option(_ plugin: PluginDescriptor, _ name: String, _ property: JsonSchemaProperty) -> some View {
        switch kind(property) {
        case .choice:
            let choices = property.enum ?? []
            let current = (plugin.config[name] ?? property.default)?.displayString ?? ""
            Picker(selection: Binding(
                get: { current },
                set: { next in
                    guard let choice = choices.first(where: { $0.displayString == next }) else { return }
                    Task { await save(plugin, name, choice) }
                }
            )) {
                ForEach(choices, id: \.self) { Text($0.displayString).tag($0.displayString) }
            } label: {
                Text(name)
                if let description = property.description { Text(description) }
            }
            .pickerStyle(.menu)
        case .flag:
            Toggle(isOn: Binding(
                get: { pending[name] ?? plugin.config[name]?.boolValue ?? property.default?.boolValue ?? false },
                set: { next in
                    pending[name] = next
                    Task {
                        await save(plugin, name, .bool(next))
                        pending[name] = nil
                    }
                }
            )) {
                Text(name)
                if let description = property.description { Text(description) }
            }
        default:
            LabeledContent {
                Text("Read Only")
            } label: {
                Text(name)
                Text("Edit this on the server (unsupported field type “\(property.type ?? "unknown")”).")
            }
        }
    }

    @discardableResult
    private func save(_ plugin: PluginDescriptor, _ name: String, _ value: JSONValue) async -> Bool {
        var config = plugin.config
        config[name] = value
        return await data.change("\(plugin.name) updated.") {
            try await store.client.setPluginConfig(id: plugin.id, config: config)
        } refetch: {
            try await store.client.plugins()
        }
    }
}

private struct PluginTextField: View {
    var name: String
    var numeric: Bool
    var value: JSONValue?
    var onSave: (JSONValue) async -> Bool

    @State private var text = ""
    @State private var busy = false

    private var original: String { value.map(\.displayString) ?? "" }
    private var number: Double? { Double(text.trimmingCharacters(in: .whitespaces)) }

    var body: some View {
        TextField(name, text: $text)
            .keyboardType(numeric ? .decimalPad : .default)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .onAppear { text = original }
            .onChange(of: original) { _, next in text = next }
        Button {
            Task {
                busy = true
                _ = await onSave(numeric ? .number(number ?? 0) : .string(text))
                busy = false
            }
        } label: {
            HStack {
                Text("Save")
                if busy { Spacer(); ProgressView() }
            }
        }
        .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || text == original || (numeric && number == nil) || busy)
    }
}

struct RunnersView: View {
    @Environment(ChatStore.self) private var store
    @State private var data = Loadable<[RunnerSummary]>()

    var body: some View {
        List {
            Notices(data: data, errorTitle: "Could not load runners")
            if let runners = data.value {
                if runners.isEmpty {
                    Banner(tone: .warn, title: "No runner connected", detail: "Chat will work, but any tool call will fail until a runner is online.")
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(runners) { runner in
                            LabeledContent {
                                Text(runner.load == 0 ? "idle" : "\(runner.load) busy")
                            } label: {
                                Text(runner.id)
                                Text(platform(runner.capabilities))
                            }
                        }
                    } footer: {
                        Text("Work happens on a runner that dials out to the server. Secrets and approvals never leave it.")
                    }
                }
            }
        }
        .navigationTitle("Runners")
        .task { await data.load { try await store.client.runners() } }
    }

    private func platform(_ caps: RunnerSummary.Capabilities) -> String {
        let base = "\(caps.os)/\(caps.arch)"
        return caps.tags.isEmpty ? base : "\(base) · \(caps.tags.joined(separator: ", "))"
    }
}

/// Tools that run without asking in the current conversation.
struct AllowlistView: View {
    @Environment(ChatStore.self) private var store
    @State private var data = Loadable<[String]>()
    @State private var adding = false
    @State private var newNames = ""
    @State private var removing: String?

    var body: some View {
        let allowed = store.allowedTools
        let known = Set(data.value ?? [])
        let custom = allowed.filter { !known.contains($0) }

        List {
            Notices(data: data, errorTitle: "Could not load tools")
            if data.value?.isEmpty == true {
                Banner(tone: .info, title: "No tools registered", detail: "The server has no registered tools right now. Tool names can still be added by hand.")
                    .listRowBackground(Color.clear)
            }
            if let tools = data.value, !tools.isEmpty {
                Section {
                    ForEach(tools, id: \.self) { name in
                        Button {
                            Haptics.selection()
                            store.setAllowedTools(allowed.contains(name) ? allowed.filter { $0 != name } : allowed + [name])
                        } label: {
                            HStack {
                                Text(name).foregroundStyle(.primary)
                                Spacer()
                                if allowed.contains(name) {
                                    Image(systemName: "checkmark").fontWeight(.semibold)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Tools")
                } footer: {
                    Text("Checked tools run unattended in the current conversation; everything else asks first.")
                }
            }
            Section {
                ForEach(custom, id: \.self) { name in
                    Button {
                        Haptics.warning()
                        removing = name
                    } label: {
                        HStack {
                            Text(name).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "checkmark").fontWeight(.semibold)
                        }
                    }
                }
                Button("Add Tool…") {
                    newNames = ""
                    adding = true
                }
            } header: {
                Text("Custom")
            } footer: {
                if !custom.isEmpty { Text("Allowed names this server does not currently report.") }
            }
        }
        .navigationTitle("Allowed Tools")
        .task { await data.load { try await store.client.tools() } }
        .alert("Add Tool", isPresented: $adding) {
            TextField("tool_name", text: $newNames)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Add") {
                var names: [String] = []
                for name in newNames.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) })
                where !name.isEmpty && !allowed.contains(name) && !names.contains(name) {
                    names.append(name)
                }
                if !names.isEmpty { store.setAllowedTools(allowed + names) }
            }
        } message: {
            Text("The exact name the server registers the tool under. Separate several with commas.")
        }
        .alert(
            "Remove “\(removing ?? "")”?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { name in
            Button("Remove", role: .destructive) { store.setAllowedTools(allowed.filter { $0 != name }) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("It will ask for approval again.")
        }
    }
}
