import type { ModelInfo } from "@hat/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { capTags, contextTag } from "./capTags";
import CreatorIcon from "./CreatorIcon";
import { creatorName, creatorSlug, groupByCreator, modelName, shortModelId } from "./creators";

interface ModelPickerProps {
  models: ModelInfo[];
  value: string;
  favorites: string[];
  onChange: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

interface Section {
  id: string;
  heading: string;
  models: ModelInfo[];
  /** Creator slug, so the heading can carry a brand mark. */
  icon?: { slug: string; name: string };
}

function byLabel(a: ModelInfo, b: ModelInfo): number {
  return modelName(a).localeCompare(modelName(b));
}

function Chevron(): JSX.Element {
  return (
    <svg className="picker-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Star({ filled }: { filled: boolean }): JSX.Element {
  return (
    <svg
      className={`picker-star ${filled ? "on" : ""}`}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8Z" />
    </svg>
  );
}

export default function ModelPicker({
  models,
  value,
  favorites,
  onChange,
  onToggleFavorite,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const current = models.find((m) => m.id === value);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (m: ModelInfo): boolean =>
      q === "" ||
      m.id.toLowerCase().includes(q) ||
      modelName(m).toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      creatorName(m).toLowerCase().includes(q);

    const favModels = models.filter((m) => favorites.includes(m.id) && matches(m)).sort(byLabel);
    const favIds = new Set(favModels.map((m) => m.id));
    const out: Section[] = [];
    if (favModels.length > 0) {
      out.push({ id: "favorites", heading: "Favorites", models: favModels });
    }

    for (const creator of groupByCreator(models)) {
      // Dedupe: favorites already have their own section — repeating them
      // below caused double highlights via flat.findIndex.
      const list = creator.models.filter((m) => matches(m) && !favIds.has(m.id));
      if (list.length === 0) continue;
      // OpenRouter's own router models have no lab behind them, and
      // "OpenRouter" is the one heading that only ever repeats the provider.
      const isRouter = creator.slug === "openrouter";
      out.push({
        id: `creator:${creator.slug}`,
        heading: isRouter ? "Router" : creator.name,
        models: list.sort(byLabel),
        icon: isRouter ? undefined : { slug: creator.slug, name: creator.name },
      });
    }
    return out;
  }, [models, favorites, query]);

  /** Flat, de-duplicated order for keyboard navigation. */
  const flat = useMemo<ModelInfo[]>(() => {
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const section of sections) {
      for (const m of section.models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }, [sections]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(id: string): void {
    onChange(id);
    setOpen(false);
  }

  function move(delta: number): void {
    if (flat.length === 0) return;
    setActive((prev) => (prev + delta + flat.length) % flat.length);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = flat[active];
      if (model) choose(model.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className={`picker-trigger ${current ? "" : "empty"}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `${modelName(current)} — ${current.id}` : "Choose a model"}
      >
        {current && <CreatorIcon slug={creatorSlug(current)} name={creatorName(current)} size={15} />}
        <span className="picker-trigger-label">{current ? modelName(current) : "no models"}</span>
        <Chevron />
      </button>

      {open && (
        <div className="picker-pop" role="dialog" aria-label="Select a model">
          <div className="picker-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              placeholder="Search models…"
              aria-label="Search models"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {query && (
              <button
                type="button"
                className="picker-clear"
                onClick={() => setQuery("")}
                title="Clear search"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          <div className="picker-list" ref={listRef} role="listbox">
            {flat.length === 0 && <div className="picker-none">No models match “{query}”</div>}

            {sections.map((section) => (
              <div className="picker-section" key={section.id}>
                <div className="picker-heading">
                  {section.icon && <CreatorIcon slug={section.icon.slug} name={section.icon.name} size={13} />}
                  <span>{section.heading}</span>
                  <span className="picker-count">{section.models.length}</span>
                </div>
                {section.models.map((m) => {
                  const index = flat.findIndex((f) => f.id === m.id);
                  const isFavorite = favorites.includes(m.id);
                  const ctx = contextTag(m.contextWindow);
                  return (
                    <div
                      className={`picker-row ${m.id === value ? "selected" : ""} ${
                        index === active ? "active" : ""
                      }`}
                      key={m.id}
                      role="option"
                      aria-selected={m.id === value}
                    >
                      <button
                        type="button"
                        className="picker-row-main"
                        ref={(el) => {
                          rowRefs.current[index] = el;
                        }}
                        onClick={() => choose(m.id)}
                        onMouseEnter={() => setActive(index)}
                      >
                        <span className="picker-row-name">{modelName(m)}</span>
                        <span className="picker-row-id">{shortModelId(m)}</span>
                        <span className="picker-tags">
                          {capTags(m.capabilities).map((tag) => (
                            <span className="cap" key={tag.key} title={tag.title}>
                              {tag.label}
                            </span>
                          ))}
                        </span>
                        {ctx && (
                          <span className="picker-ctx" title={ctx.title}>
                            {ctx.label}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="picker-fav"
                        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                        aria-label={isFavorite ? `Remove ${modelName(m)} from favorites` : `Add ${modelName(m)} to favorites`}
                        aria-pressed={isFavorite}
                        onClick={() => onToggleFavorite(m.id)}
                      >
                        <Star filled={isFavorite} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
