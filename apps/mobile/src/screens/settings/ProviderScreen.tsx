/**
 * One provider's API key: set it, replace it, or remove it.
 *
 * The field is always empty, even when a key is set, because the server never
 * returns a stored key. Saving writes a new one over whatever is there.
 */

import { useLayoutEffect, useState } from "react";
import * as api from "../../api";
import { Button, Field } from "../../ui/controls";
import { ListRow, ListSection } from "../../ui/List";
import { confirmDestructive, FormRow, Notices, SectionBanner, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

export default function ProviderScreen({ navigation, route }: SettingsScreenProps<"Provider">) {
  const { data: providers, error, notice, dismissNotice, guard } = useServerData("providers");
  const provider = providers?.find((p) => p.id === route.params.providerId);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: provider?.label ?? "" });
  }, [navigation, provider?.label]);

  if (!provider) {
    return (
      <SettingsScroll>
        <Notices error={error} errorTitle="Could not load provider" />
        {providers ? (
          <SectionBanner
            tone="warn"
            title="Provider not found"
            detail="The server no longer reports this provider."
          />
        ) : null}
      </SettingsScroll>
    );
  }

  const save = async () => {
    setBusy(true);
    const saved = await guard(
      () => api.setSecret(provider.secretName, value.trim()),
      `${provider.label} key saved.`,
    );
    if (saved) setValue("");
    setBusy(false);
  };

  return (
    <SettingsScroll>
      <Notices error={error} notice={notice} onDismissNotice={dismissNotice} />

      <ListSection header="Status">
        <ListRow title="API Key" value={provider.configured ? "Set" : "Not Set"} />
        <ListRow title="Provider" value={provider.registered ? "Registered" : "Not Registered"} />
        {provider.status ? <ListRow title="Status" value={provider.status} /> : null}
      </ListSection>

      <ListSection
        header={provider.configured ? "Replace Key" : "Set Key"}
        footer="Keys are sent to the server and stored encrypted there. They never reach this device again."
      >
        <FormRow>
          <Field
            label={provider.secretName}
            value={value}
            onChangeText={setValue}
            secureTextEntry
            placeholder={provider.configured ? "New key" : "Paste key"}
          />
          <Button
            label="Save"
            variant="primary"
            loading={busy}
            disabled={!value.trim()}
            onPress={() => void save()}
          />
        </FormRow>
      </ListSection>

      {provider.configured ? (
        <ListSection>
          <ListRow
            title="Remove Key"
            destructive
            onPress={() =>
              confirmDestructive({
                title: `Remove the ${provider.label} key?`,
                message: "Models from this provider stop working until a new key is set.",
                action: "Remove",
                onConfirm: () =>
                  void guard(
                    () => api.deleteSecret(provider.secretName),
                    `${provider.label} key removed.`,
                  ),
              })
            }
          />
        </ListSection>
      ) : null}
    </SettingsScroll>
  );
}
