/**
 * Tools that run without asking when the conversation's policy is Allowlist.
 *
 * The server's registered tool names are offered as a checklist. Names it does
 * not report are kept in a separate Custom section rather than dropped: a tool
 * can belong to a runner that is offline right now, and silently removing it
 * from the allowlist would change the policy behind the user's back.
 */

import { Alert, Platform } from "react-native";
import * as haptics from "../../haptics";
import { useChatStore } from "../../navigation";
import { ListRow, ListSection } from "../../ui/List";
import { confirmDestructive, Notices, SectionBanner, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

export default function AllowlistScreen(_: SettingsScreenProps<"Allowlist">) {
  const chat = useChatStore();
  const { data: known, error } = useServerData("tools");
  const allowed = chat.allowedTools;
  const selected = new Set(allowed);
  const knownSet = new Set(known ?? []);
  const custom = allowed.filter((name) => !knownSet.has(name));
  // Alert.prompt exists only on iOS; elsewhere custom names can't be typed here.
  const canAdd = Platform.OS === "ios";

  const toggle = (name: string) => {
    haptics.selection();
    chat.setAllowedTools(selected.has(name) ? allowed.filter((v) => v !== name) : [...allowed, name]);
  };

  const add = () => {
    Alert.prompt(
      "Add Tool",
      "The exact name the server registers the tool under. Separate several with commas.",
      (text) => {
        const names = text
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && !selected.has(s));
        if (names.length > 0) chat.setAllowedTools([...allowed, ...new Set(names)]);
      },
      "plain-text",
      "",
      "default",
    );
  };

  return (
    <SettingsScroll>
      <Notices error={error} errorTitle="Could not load tools" />

      {known?.length === 0 ? (
        <SectionBanner
          tone="info"
          title="No tools registered"
          detail={
            canAdd
              ? "The server has no registered tools right now. Tool names can still be added by hand."
              : "The server has no registered tools right now, so there is nothing to allowlist."
          }
        />
      ) : null}

      {known && known.length > 0 ? (
        <ListSection
          header="Tools"
          footer="Checked tools run unattended in the current conversation; everything else asks first."
        >
          {known.map((name) => (
            <ListRow
              key={name}
              title={name}
              accessory={selected.has(name) ? "check" : undefined}
              onPress={() => toggle(name)}
            />
          ))}
        </ListSection>
      ) : null}

      {custom.length > 0 || canAdd ? (
        <ListSection
          header="Custom"
          footer={custom.length > 0 ? "Allowed names this server does not currently report." : undefined}
        >
          {custom.map((name) => (
            <ListRow
              key={name}
              title={name}
              accessory="check"
              onPress={() =>
                confirmDestructive({
                  title: `Remove “${name}”?`,
                  message: "It will ask for approval again.",
                  action: "Remove",
                  onConfirm: () => chat.setAllowedTools(allowed.filter((v) => v !== name)),
                })
              }
            />
          ))}
          {canAdd ? <ListRow key="add" title="Add Tool…" action onPress={add} /> : null}
        </ListSection>
      ) : null}
    </SettingsScroll>
  );
}
