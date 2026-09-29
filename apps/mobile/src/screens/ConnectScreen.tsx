/**
 * First-run screen: point the app at a hat server.
 *
 * There is no login form here on purpose. The server's browser flow sets an
 * HttpOnly session cookie and requires a CSRF token on every mutation, which a
 * native client has no good use for. `HAT_AUTH_TOKEN` is accepted as a bearer
 * credential and is exempt from both, so the token is the whole of it.
 *
 * The URL and token are probed before being saved, so a typo here fails
 * immediately and specifically rather than as a confusing error on the first
 * send.
 */

import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { hasNativeGlass } from "../Glass";
import * as haptics from "../haptics";
import type { HatConfig } from "../runtime";
import { normalizeServerUrl, probeConnection, saveConfig } from "../runtime";
import { useTheme } from "../theme";
import { Banner, Button, Field, SECTION_RADIUS } from "../ui/controls";
import Icon from "../ui/Icon";

export default function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const theme = useTheme();
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const config: HatConfig = { serverUrl, token };
      await probeConnection(config);
      await saveConfig(config);
      haptics.success();
      onConnected();
    } catch (e) {
      haptics.error();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const normalized = normalizeServerUrl(serverUrl);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.color.grouped }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <View style={styles.hero}>
            <View style={[styles.appIcon, { backgroundColor: theme.color.accent }]}>
              <Icon name="server.rack" size={34} weight="medium" color={theme.color.accentText} />
            </View>
            <Text style={[styles.wordmark, { color: theme.color.text }]}>Connect to hat</Text>
            <Text style={[styles.tagline, { color: theme.color.textDim }]}>
              Enter the address of your hat server and its access token.
            </Text>
          </View>

          {/* The form is content, not chrome, so it is a solid inset-grouped
              card: Liquid Glass is for controls floating over content. */}
          <View style={[styles.card, { backgroundColor: theme.color.surface }]}>
              <Field
                label="Server URL"
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="https://hat.example.ts.net"
                keyboardType="url"
                hint={
                  normalized
                    ? `Requests go to ${normalized}/api`
                    : "The address the hat server is reachable at."
                }
              />
              <Field
                label="Access token"
                value={token}
                onChangeText={setToken}
                placeholder="HAT_AUTH_TOKEN"
                secureTextEntry
                hint="Stored in the iOS keychain and sent as a bearer token. Leave blank only if your server has no auth set."
              />

              {error ? <Banner tone="error" title="Could not connect" detail={error} /> : null}

              <Button
                label={busy ? "Checking…" : "Connect"}
                onPress={connect}
                variant="primary"
                loading={busy}
                disabled={!normalized}
              />
          </View>

          <Text style={[styles.footnote, { color: theme.color.textFaint }]}>
            {hasNativeGlass()
              ? "Liquid Glass is active on this device."
              : "Liquid Glass is unavailable here; chrome uses a material blur."}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
    gap: 24,
  },
  hero: { gap: 8, alignItems: "center" },
  appIcon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  wordmark: { fontSize: 28, fontWeight: "700", letterSpacing: 0.3, textAlign: "center" },
  tagline: { fontSize: 17, lineHeight: 22, textAlign: "center" },
  card: { borderRadius: SECTION_RADIUS, padding: 16, gap: 18 },
  footnote: { fontSize: 12, textAlign: "center" },
});
