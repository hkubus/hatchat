import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "./icons";

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description: string;
  /** Leave the menu open after picking this, for a follow-up field in the footer. */
  keepOpen?: boolean;
}

interface ComposerMenuProps<T extends string> {
  /** Accessible name of the control, also the popover heading. */
  label: string;
  icon: ReactNode;
  value: T;
  options: ReadonlyArray<MenuOption<T>>;
  onChange: (value: T) => void;
  /** Text shown next to the icon; omitted for an icon-only trigger. */
  display?: string;
  /** Tints the trigger: the setting is away from its default. */
  tone?: "accent" | "warn";
  title?: string;
  /** Extra controls under the options (e.g. the allowlist field). */
  footer?: ReactNode;
  /**
   * Called whenever the menu closes. A footer field unmounts with the menu, and
   * a removed input never fires its blur, so this is where it gets saved.
   */
  onClose?: () => void;
}

/**
 * A small upward popover for one composer setting. Replaces a native <select>
 * so the options can carry a line of explanation and the trigger can shrink to
 * an icon when the setting is at its default.
 */
export default function ComposerMenu<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
  display,
  tone,
  title,
  footer,
  onClose,
}: ComposerMenuProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  function close(): void {
    setOpen(false);
    onCloseRef.current?.();
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="cmenu" ref={rootRef}>
      <button
        type="button"
        className={`cmenu-trigger ${tone ?? ""} ${display ? "" : "icon-only"} ${open ? "open" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={display ? `${label}: ${display}` : label}
        title={title}
      >
        {icon}
        {display && <span>{display}</span>}
      </button>
      {open && (
        <div className="cmenu-pop" role="menu" aria-label={label}>
          <div className="cmenu-heading">{label}</div>
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              key={option.value}
              className={`cmenu-item ${option.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                if (!option.keepOpen) close();
              }}
            >
              <span className="cmenu-item-text">
                <span className="cmenu-item-label">{option.label}</span>
                <span className="cmenu-item-desc">{option.description}</span>
              </span>
              {option.value === value && <CheckIcon className="cmenu-check" />}
            </button>
          ))}
          {footer}
        </div>
      )}
    </div>
  );
}
