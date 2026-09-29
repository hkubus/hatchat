/**
 * Haptic feedback, named for *why* it fires rather than which generator it
 * uses, so every screen gives the same feel for the same kind of moment.
 *
 * iOS only: the web preview has no Taptic Engine, and Android's vibration
 * motor feels nothing like it, so there the calls are no-ops. Failures are
 * swallowed — a missing buzz must never surface as an error.
 */

import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

const enabled = Platform.OS === "ios";

function run(effect: () => Promise<void>): void {
  if (!enabled) return;
  void effect().catch(() => undefined);
}

/** A light tap: a button that commits something small (send, attach). */
export function tap(): void {
  run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A value changed in a picker or menu. */
export function selection(): void {
  run(() => Haptics.selectionAsync());
}

/** Something finished well: a reply landed, a key was saved, a copy happened. */
export function success(): void {
  run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Needs attention: a tool is waiting for approval, or a destructive action. */
export function warning(): void {
  run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** Something failed. */
export function error(): void {
  run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}
