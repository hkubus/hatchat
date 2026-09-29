/**
 * Desktop notifications for a conversation that needs the user while they are
 * looking elsewhere: a turn finished, or it is blocked on an approval or a
 * question. Opt-in (Settings → Preferences), and only fired while the page is
 * hidden — a visible tab already shows all of this.
 *
 * This covers the web app and the desktop shell while they are open. Reaching
 * a closed tab or a suspended phone needs server push, which is not built.
 */

const KEY = "hat.notify";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationsEnabled(): boolean {
  return (
    notificationsSupported() &&
    localStorage.getItem(KEY) === "1" &&
    Notification.permission === "granted"
  );
}

/** Turn notifications on (asking the browser for permission) or off. Resolves the new state. */
export async function setNotificationsEnabled(enabled: boolean): Promise<boolean> {
  if (!enabled || !notificationsSupported()) {
    localStorage.removeItem(KEY);
    return false;
  }
  const permission =
    Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") {
    localStorage.removeItem(KEY);
    return false;
  }
  localStorage.setItem(KEY, "1");
  return true;
}

/**
 * Show a notification if enabled and the page is hidden. `tag` collapses
 * repeats for the same conversation into one.
 */
export function notify(title: string, body: string, tag: string, onClick?: () => void): void {
  if (!notificationsEnabled() || !document.hidden) return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Some webviews expose the API but refuse to construct notifications.
  }
}
