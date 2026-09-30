#!/usr/bin/env node
// Builds the SideStore / AltStore source (`source.json`) from the repository's
// GitHub releases. Each iOS build is published by ios-ipa.yml as a release
// tagged `ios-<version>-b<build>` with the unsigned IPA attached; this turns
// those releases into the source's version list, newest first.
//
//   node sidestore-source.mjs <releases.json> <site-url> [repo-url] > source.json
//
// `releases.json` is the output of `gh api repos/<owner>/<repo>/releases
// --paginate --slurp` (an array of pages, or one flat array). `site-url` is
// where the source and icon are served (GitHub Pages), used for the icon URL.
//
// Format: https://faq.altstore.io/developers/make-a-source

import { readFileSync } from "node:fs";

const BUNDLE_ID = "chat.t3code.hat";
const MIN_OS = "18.0";
// Enough history to roll back a few builds without an ever-growing file.
const MAX_VERSIONS = 20;
const TAG = /^ios-(\d+(?:\.\d+)*)-b(\d+)$/;

export function buildSource(releases, siteUrl, repoUrl) {
  const site = siteUrl.replace(/\/+$/, "");
  const versions = releases
    .flat()
    .filter((r) => !r.draft)
    .map((r) => {
      const tag = TAG.exec(r.tag_name ?? "");
      const ipa = (r.assets ?? []).find((a) => a.name.endsWith(".ipa"));
      if (!tag || !ipa) return undefined;
      return {
        version: tag[1],
        buildVersion: tag[2],
        date: r.published_at ?? r.created_at,
        localizedDescription: (r.body ?? "").trim() || `Build ${tag[2]}`,
        downloadURL: ipa.browser_download_url,
        size: ipa.size,
        minOSVersion: MIN_OS,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.buildVersion) - Number(a.buildVersion))
    .slice(0, MAX_VERSIONS);

  return {
    name: "hat",
    identifier: `${BUNDLE_ID}.source`,
    subtitle: "Self-hosted multi-provider chat",
    description:
      "Builds of the hat iOS app, straight from CI. The IPA is unsigned; SideStore signs it on your device.",
    iconURL: `${site}/icon.png`,
    ...(repoUrl ? { website: repoUrl } : {}),
    tintColor: "#DC3E42",
    apps: [
      {
        name: "hat",
        bundleIdentifier: BUNDLE_ID,
        developerName: "kubus",
        subtitle: "Chat with any model through your own hat server",
        localizedDescription:
          "Native client for a hat server: conversations with any configured provider, tool approvals, branches, attachments and live streaming. Connect with your server URL and token.",
        iconURL: `${site}/icon.png`,
        tintColor: "#DC3E42",
        category: "utilities",
        screenshots: [],
        versions,
        appPermissions: {
          entitlements: [],
          privacy: {
            NSCameraUsageDescription: "Take a photo to attach to a conversation.",
          },
        },
      },
    ],
    news: [],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, siteUrl, repoUrl] = process.argv.slice(2);
  if (!file || !siteUrl) {
    console.error("usage: sidestore-source.mjs <releases.json> <site-url> [repo-url]");
    process.exit(2);
  }
  const source = buildSource(JSON.parse(readFileSync(file, "utf8")), siteUrl, repoUrl);
  if (source.apps[0].versions.length === 0) {
    console.error("no ios-<version>-b<build> release with an .ipa asset found");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(source, null, 2)}\n`);
}
