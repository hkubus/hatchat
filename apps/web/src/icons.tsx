/**
 * The inline icon set used by the per-message action row and the collapsible
 * reasoning / tool-call disclosures.
 *
 * The app ships no icon dependency, so these are hand-written on one 24x24 grid
 * with a single shared stroke treatment. Sizing and colour are left to CSS
 * (`.icon-btn svg`, `.disclosure`), which is why none of them carry dimensions
 * of their own.
 */

import type { ReactNode } from "react";

interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

export function RegenerateIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </Svg>
  );
}

export function EditIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="15 18 9 12 15 6" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="9 18 15 12 9 6" />
    </Svg>
  );
}

/** Collapsed disclosures point down; CSS rotates it 90° once `[open]` applies. */
export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

export function ForkIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" />
    </Svg>
  );
}

export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </Svg>
  );
}

export function DownloadIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </Svg>
  );
}

export function GearIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Svg>
  );
}

export function ImportIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
    </Svg>
  );
}

export function SignOutIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </Svg>
  );
}

export function MenuIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function PaperclipIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21.4 11.05 12.5 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </Svg>
  );
}

/** Reasoning effort: a small bulb whose rays stand for "thinking harder". */
export function BulbIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" />
    </Svg>
  );
}

export function WrenchIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M14.7 6.3a4 4 0 0 0 5 5L21 13a6 6 0 0 1-7.6 1.4l-6.7 6.7a2.1 2.1 0 0 1-3-3l6.7-6.7A6 6 0 0 1 11.8 3.8Z" />
    </Svg>
  );
}

/** The app mark: a top hat in the accent colour. */
export function HatMark({ className }: IconProps): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="var(--accent)"
        d="M7.5 4.5c0-.8.7-1.5 1.5-1.5h6c.8 0 1.5.7 1.5 1.5V15h-9Z M2.5 16.8c0-.5.4-.8.9-.8h17.2c.5 0 .9.3.9.8 0 1.8-3.6 3.2-9.5 3.2s-9.5-1.4-9.5-3.2Z"
      />
      <path fill="var(--bg)" d="M7.5 12h9v2h-9Z" />
    </svg>
  );
}
