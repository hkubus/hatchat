/**
 * Per-conversation settings: instructions, temperature and the reply-token
 * cap. All three are stored on the server session (`PATCH /api/sessions/:id`)
 * and apply to this conversation only.
 *
 * The form is shared by two routes: a page sheet over the chat (opened from
 * the conversation's options menu) and a screen pushed inside the Settings
 * sheet's own stack. Edits are held locally and saved with the bar's Save
 * button, as in Contacts or Calendar; Cancel (or Back) discards them.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import * as haptics from "../haptics";
import { useChatStore } from "../navigation";
import type { ScreenProps } from "../navigation";
import { useTheme } from "../theme";
import type { ConversationSettings } from "../useChat";
import { barItems } from "../ui/barItems";
import { ListRow, ListSection } from "../ui/List";
import { Notices, SettingsScroll } from "./settings/shared";

/** Mirrors the server's limit, so an over-long paste fails here, not on Save. */
const MAX_INSTRUCTIONS = 20_000;

/** The parts of a stack navigation prop the form needs; both stacks provide them. */
interface FormNavigation {
  setOptions: (options: Partial<NativeStackNavigationOptions>) => void;
  goBack: () => void;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** "" is the provider default; a comma is accepted as the decimal separator. */
function parseTemperature(text: string): Parsed<number | null> {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    return { ok: false, error: "Temperature must be a number from 0 to 2." };
  }
  return { ok: true, value };
}

function parseMaxTokens(text: string): Parsed<number | null> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: "Max reply tokens must be a whole number above zero." };
  }
  return { ok: true, value };
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** A settings row with a trailing text field instead of a value. */
function InputRow({
  title,
  value,
  onChangeText,
  keyboardType,
  invalid,
}: {
  title: string;
  value: string;
  onChangeText: (next: string) => void;
  keyboardType: "decimal-pad" | "number-pad";
  invalid: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.inputRow}>
      <Text style={[styles.inputTitle, { color: theme.color.text }]}>{title}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Default"
        placeholderTextColor={theme.color.textFaint}
        keyboardType={keyboardType}
        accessibilityLabel={title}
        style={[
          styles.inputField,
          { color: invalid ? theme.color.danger : theme.color.textDim },
        ]}
      />
    </View>
  );
}

export function ConversationForm({
  navigation,
  sheet,
}: {
  navigation: FormNavigation;
  /** Presented as a sheet: gets a Cancel button, since there is no Back. */
  sheet: boolean;
}) {
  const theme = useTheme();
  const chat = useChatStore();
  const session = chat.session;

  const initial = useMemo(
    () => ({
      instructions: session?.instructions ?? "",
      temperature: numberText(session?.temperature),
      maxTokens: numberText(session?.maxTokens),
    }),
    [session?.instructions, session?.temperature, session?.maxTokens],
  );

  const [instructions, setInstructions] = useState(initial.instructions);
  const [temperature, setTemperature] = useState(initial.temperature);
  const [maxTokens, setMaxTokens] = useState(initial.maxTokens);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedTemperature = parseTemperature(temperature);
  const parsedMaxTokens = parseMaxTokens(maxTokens);
  const tooLong = instructions.length > MAX_INSTRUCTIONS;
  const problem = tooLong
    ? `Instructions are limited to ${MAX_INSTRUCTIONS.toLocaleString()} characters.`
    : !parsedTemperature.ok
      ? parsedTemperature.error
      : !parsedMaxTokens.ok
        ? parsedMaxTokens.error
        : null;

  const dirty =
    instructions.trim() !== initial.instructions.trim() ||
    temperature.trim() !== initial.temperature ||
    maxTokens.trim() !== initial.maxTokens;
  const canSave = dirty && !problem && !saving;

  const save = async () => {
    if (!parsedTemperature.ok || !parsedMaxTokens.ok || tooLong) return;
    const settings: ConversationSettings = {
      instructions: instructions.trim(),
      temperature: parsedTemperature.value,
      maxTokens: parsedMaxTokens.value,
    };
    setSaving(true);
    setError(null);
    try {
      await chat.updateConversation(settings);
      haptics.success();
      navigation.goBack();
    } catch (e) {
      haptics.error();
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };
  // The bar button reads the latest form through a ref, so the bar is rebuilt
  // only when Save's enabled state changes rather than on every keystroke.
  const saveRef = useRef(save);
  saveRef.current = save;

  useLayoutEffect(() => {
    navigation.setOptions({
      ...(sheet
        ? barItems("left", [{ kind: "button", label: "Cancel", onPress: () => navigation.goBack() }])
        : {}),
      ...barItems("right", [
        {
          kind: "button",
          label: "Save",
          variant: "done",
          disabled: !canSave,
          onPress: () => void saveRef.current(),
        },
      ]),
    });
  }, [navigation, sheet, canSave]);

  const isDefault = !instructions.trim() && !temperature.trim() && !maxTokens.trim();

  return (
    <SettingsScroll>
      <Notices error={error ?? problem} errorTitle={error ? "Could not save" : "Check this"} />

      <ListSection
        header="Instructions"
        footer="Added to the system prompt for this conversation only. Use it for a persona, a language, or a house style."
      >
        <TextInput
          value={instructions}
          onChangeText={setInstructions}
          multiline
          placeholder="e.g. Answer in British English and keep it brief."
          placeholderTextColor={theme.color.textFaint}
          accessibilityLabel="Instructions"
          style={[styles.instructions, { color: theme.color.text }]}
        />
      </ListSection>

      <ListSection
        header="Sampling"
        footer="Temperature runs from 0 (focused) to 2 (varied). Max reply tokens caps each model call; a reply cut off by it can be continued. Leave either empty for the model’s default."
      >
        <InputRow
          title="Temperature"
          value={temperature}
          onChangeText={setTemperature}
          keyboardType="decimal-pad"
          invalid={!parsedTemperature.ok}
        />
        <InputRow
          title="Max Reply Tokens"
          value={maxTokens}
          onChangeText={setMaxTokens}
          keyboardType="number-pad"
          invalid={!parsedMaxTokens.ok}
        />
      </ListSection>

      <ListSection>
        <ListRow
          title="Reset to Defaults"
          action
          disabled={isDefault}
          onPress={() => {
            haptics.selection();
            setInstructions("");
            setTemperature("");
            setMaxTokens("");
          }}
        />
      </ListSection>
    </SettingsScroll>
  );
}

/** The page sheet over the chat. */
export default function ConversationScreen({ navigation }: ScreenProps<"Conversation">) {
  return <ConversationForm navigation={navigation} sheet />;
}

const styles = StyleSheet.create({
  instructions: {
    minHeight: 132,
    maxHeight: 320,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 17,
    textAlignVertical: "top",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  inputTitle: { fontSize: 17, letterSpacing: -0.4 },
  inputField: { flex: 1, minHeight: 44, fontSize: 17, textAlign: "right" },
});
