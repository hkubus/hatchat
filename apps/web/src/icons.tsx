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
