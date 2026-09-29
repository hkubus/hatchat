/**
 * Providers that need an API key on the server, and whether each has one.
 *
 * Only the key's presence is ever known here: the server stores keys encrypted
 * and never sends them back, so this list is status, and the key itself is set
 * or replaced blind on the Provider screen.
 */

import { ListRow, ListSection } from "../../ui/List";
import { Notices, SectionBanner, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

export default function ProvidersScreen({ navigation }: SettingsScreenProps<"Providers">) {
  const { data: providers, error } = useServerData("providers");

  return (
    <SettingsScroll>
      <Notices error={error} errorTitle="Could not load providers" />
      {providers?.length === 0 ? (
        <SectionBanner tone="info" title="This server exposes no key-backed providers." />
      ) : null}
      {providers && providers.length > 0 ? (
        <ListSection footer="Keys are sent to the server and stored encrypted there. They never reach this device again.">
          {providers.map((provider) => (
            <ListRow
              key={provider.id}
              title={provider.label}
              subtitle={provider.secretName}
              value={provider.configured ? "Set" : "Not Set"}
              accessory="chevron"
              onPress={() => navigation.navigate("Provider", { providerId: provider.id })}
            />
          ))}
        </ListSection>
      ) : null}
    </SettingsScroll>
  );
}
