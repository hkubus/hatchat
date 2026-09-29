/**
 * One plugin's configuration, generated from the JSON Schema it declares.
 *
 * Booleans and enums are single-tap settings, so they are rows in one section;
 * strings and numbers need typing and an explicit Save, so each gets a section
 * of its own with its description as the footer.
 */

import { useLayoutEffect, useState } from "react";
import * as api from "../../api";
import type { JsonSchemaProperty } from "../../api";
import { Button, Field } from "../../ui/controls";
import { ListRow, ListSection } from "../../ui/List";
import { FormRow, Notices, PickerRow, SectionBanner, SettingSwitch, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

type SaveField = (name: string, next: unknown) => Promise<boolean>;

/**
 * Only the shapes the schema-to-form conversion in the kernel actually emits
 * are editable: string, number, boolean, and enum. Anything else is shown
 * read-only rather than guessed at, because writing a wrong value into a
 * plugin's config is worse than not offering the field.
 */
function kindOf(property: JsonSchemaProperty): "enum" | "boolean" | "text" | "unsupported" {
  if (property.enum) return "enum";
  if (property.type === "boolean") return "boolean";
  if (property.type === "string" || property.type === "number" || property.type === "integer") {
    return "text";
  }
  return "unsupported";
}

export default function PluginScreen({ navigation, route }: SettingsScreenProps<"Plugin">) {
  const { data: plugins, error, notice, dismissNotice, guard } = useServerData("plugins");
  const plugin = plugins?.find((p) => p.id === route.params.pluginId);
  // Same reason as the plugin list: hold a toggled value until the refetch lands.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useLayoutEffect(() => {
    navigation.setOptions({ title: plugin?.name ?? "" });
  }, [navigation, plugin?.name]);

  if (!plugin) {
    return (
      <SettingsScroll>
        <Notices error={error} errorTitle="Could not load plugin" />
        {plugins ? (
          <SectionBanner
            tone="warn"
            title="Plugin not found"
            detail="The server no longer reports this plugin."
          />
        ) : null}
      </SettingsScroll>
    );
  }

  const save: SaveField = (name, next) =>
    guard(() => api.setPluginConfig(plugin.id, { ...plugin.config, [name]: next }), `${plugin.name} updated.`);

  const toggle = async (name: string, next: boolean) => {
    setPending((prev) => ({ ...prev, [name]: next }));
    await save(name, next);
    setPending(({ [name]: _, ...rest }) => rest);
  };

  const fields = Object.entries(plugin.configSchema?.properties ?? {});
  const rows = fields.filter(([, property]) => kindOf(property) !== "text");
  const texts = fields.filter(([, property]) => kindOf(property) === "text");

  return (
    <SettingsScroll>
      <Notices error={error} notice={notice} onDismissNotice={dismissNotice} />
      {plugin.error ? <SectionBanner tone="error" title="Plugin error" detail={plugin.error} /> : null}

      {rows.length > 0 ? (
        <ListSection header="Options" footer={plugin.description}>
          {rows.map(([name, property]) => (
            <OptionRow
              key={name}
              name={name}
              property={property}
              value={plugin.config[name]}
              pending={pending[name]}
              onToggle={(next) => void toggle(name, next)}
              onSave={save}
            />
          ))}
        </ListSection>
      ) : null}

      {texts.map(([name, property]) => (
        <ListSection key={name} footer={property.description}>
          <TextField
            // Remount when the server's value changes, so the field shows it.
            key={String(plugin.config[name] ?? "")}
            name={name}
            numeric={property.type !== "string"}
            value={plugin.config[name]}
            onSave={save}
          />
        </ListSection>
      ))}

      {fields.length === 0 ? (
        <SectionBanner tone="info" title="This plugin has no settings." />
      ) : null}
    </SettingsScroll>
  );
}

function OptionRow({
  name,
  property,
  value,
  pending,
  onToggle,
  onSave,
}: {
  name: string;
  property: JsonSchemaProperty;
  value: unknown;
  pending: boolean | undefined;
  onToggle: (next: boolean) => void;
  onSave: SaveField;
}) {
  const kind = kindOf(property);

  if (kind === "enum") {
    const current = value ?? property.default;
    return (
      <PickerRow
        title={name}
        subtitle={property.description}
        // Compared as strings, but the option saved is the schema's own value, so
        // a numeric enum is never written back as a string.
        value={String(current ?? "")}
        options={(property.enum ?? []).map((option) => ({ value: String(option), label: String(option) }))}
        onChange={(next) => {
          const option = property.enum?.find((o) => String(o) === next);
          void onSave(name, option);
        }}
      />
    );
  }

  if (kind === "boolean") {
    return (
      <ListRow
        title={name}
        subtitle={property.description}
        accessory={
          <SettingSwitch
            value={pending ?? (value === undefined ? Boolean(property.default) : Boolean(value))}
            onValueChange={onToggle}
          />
        }
      />
    );
  }

  // No editor for shapes the schema-to-form conversion does not emit (objects,
  // arrays). Writing a guessed value into a plugin's config is worse than not
  // offering the field at all.
  return (
    <ListRow
      title={name}
      subtitle={`Edit this on the server (unsupported field type “${property.type ?? "unknown"}”).`}
      value="Read Only"
      disabled
    />
  );
}

function TextField({
  name,
  numeric,
  value,
  onSave,
}: {
  name: string;
  numeric: boolean;
  value: unknown;
  onSave: SaveField;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [busy, setBusy] = useState(false);
  const invalidNumber = numeric && !Number.isFinite(Number(text));

  return (
    <FormRow>
      <Field
        label={name}
        value={text}
        onChangeText={setText}
        keyboardType={numeric ? "numeric" : "default"}
      />
      <Button
        label="Save"
        variant="primary"
        loading={busy}
        // A number field that has not been touched must not write "0" over a
        // value the server already has.
        disabled={!text.trim() || text === String(value ?? "") || invalidNumber}
        onPress={() => {
          setBusy(true);
          void onSave(name, numeric ? Number(text) : text).finally(() => setBusy(false));
        }}
      />
    </FormRow>
  );
}
