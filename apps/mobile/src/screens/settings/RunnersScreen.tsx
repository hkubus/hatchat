/**
 * Execution runners connected to the server.
 *
 * Runners dial out to the server rather than the other way round, so this list
 * is simply who is connected right now. With none, chat still works but every
 * tool call fails, which is worth saying loudly.
 */

import { ListRow, ListSection } from "../../ui/List";
import { Notices, SectionBanner, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

const FOOTER =
  "Work happens on a runner that dials out to the server. Secrets and approvals never leave it.";

export default function RunnersScreen(_: SettingsScreenProps<"Runners">) {
  const { data: runners, error } = useServerData("runners");

  return (
    <SettingsScroll>
      <Notices error={error} errorTitle="Could not load runners" />
      {runners?.length === 0 ? (
        <SectionBanner
          tone="warn"
          title="No runner connected"
          detail="Chat will work, but any tool call will fail until a runner is online."
        />
      ) : null}
      {runners && runners.length > 0 ? (
        <ListSection footer={FOOTER}>
          {runners.map((runner) => {
            const { os, arch, tags } = runner.capabilities;
            return (
              <ListRow
                key={runner.id}
                title={runner.id}
                subtitle={`${os}/${arch}${tags.length > 0 ? ` · ${tags.join(", ")}` : ""}`}
                value={runner.load === 0 ? "idle" : `${runner.load} busy`}
              />
            );
          })}
        </ListSection>
      ) : null}
    </SettingsScroll>
  );
}
