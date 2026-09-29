/**
 * Edit the server URL and access token of the current connection.
 *
 * The candidate is probed before it is saved, as on the connect screen, so a
 * typo fails here, specifically, instead of breaking every screen after it.
 */

import { useState } from "react";
import * as haptics from "../../haptics";
import { currentConfig, normalizeServerUrl, probeConnection, saveConfig } from "../../runtime";
import { Button, Field } from "../../ui/controls";
import { ListSection } from "../../ui/List";
import { FormRow, Notices, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { errorMessage } from "./useServerData";

export default function ConnectionScreen({ navigation }: SettingsScreenProps<"Connection">) {
  const [serverUrl, setServerUrl] = useState(currentConfig().serverUrl);
  const [token, setToken] = useState(currentConfig().token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = normalizeServerUrl(serverUrl);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = { serverUrl, token };
      await probeConnection(config);
      await saveConfig(config);
      haptics.success();
      navigation.goBack();
    } catch (e) {
      haptics.error();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsScroll>
      <Notices error={error} errorTitle="Could not connect" />
      <ListSection footer="The connection is checked before it is saved.">
        <FormRow>
          <Field
            label="Server URL"
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://hat.example.ts.net"
            keyboardType="url"
            hint={normalized ? `Requests go to ${normalized}/api` : undefined}
          />
          <Field
            label="Access token"
            value={token}
            onChangeText={setToken}
            placeholder="HAT_AUTH_TOKEN"
            secureTextEntry
            hint="Stored in the iOS keychain."
          />
          <Button
            label={busy ? "Checking…" : "Save"}
            variant="primary"
            loading={busy}
            disabled={!normalized}
            onPress={() => void save()}
          />
        </FormRow>
      </ListSection>
    </SettingsScroll>
  );
}
