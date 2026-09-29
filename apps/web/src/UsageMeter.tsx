interface UsageMeterProps {
  /** Share of the context window the last request used, 0..1; null when unknown. */
  fraction: number | null;
  /** Conversation token total, already formatted ("4.2k"); shown when there is no fraction. */
  tokensLabel: string;
  title: string;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Context use as a small ring, with the numbers in its tooltip. It only turns
 * into text when it matters: past 80% of the window, or when the model's
 * window is unknown and the token count is all there is to show.
 */
export default function UsageMeter({ fraction, tokensLabel, title }: UsageMeterProps): JSX.Element | null {
  if (fraction === null) {
    return tokensLabel ? (
      <span className="usage-meter" title={title}>
        {tokensLabel}
      </span>
    ) : null;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  const level = clamped >= 0.9 ? "danger" : clamped >= 0.8 ? "warn" : "";
  return (
    <span className={`usage-meter ${level}`} title={title} aria-label={title}>
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <circle className="usage-track" cx="9" cy="9" r={RADIUS} />
        <circle
          className="usage-fill"
          cx="9"
          cy="9"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped)}
        />
      </svg>
      {level && `${Math.round(clamped * 100)}%`}
    </span>
  );
}
