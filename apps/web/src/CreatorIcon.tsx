import { brandIcon, creatorInitial } from "./creators";

interface CreatorIconProps {
  /** Creator slug, used to look up the brand mark. */
  slug: string;
  /** Creator display name, used for the monogram and the tooltip. */
  name: string;
  /** Pixel size of the square icon. */
  size?: number;
}

/**
 * A creator's brand mark, or a neutral monogram when we have no mark for it.
 */
export default function CreatorIcon({ slug, name, size = 16 }: CreatorIconProps) {
  const icon = brandIcon(slug);

  if (icon) {
    return (
      <span className="creator-icon" style={{ width: size, height: size }} title={name}>
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
          <path d={icon.d} fill={`#${icon.hex}`} />
        </svg>
      </span>
    );
  }

  return (
    <span
      className="creator-icon monogram"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
      title={name}
    >
      {creatorInitial(name)}
    </span>
  );
}
