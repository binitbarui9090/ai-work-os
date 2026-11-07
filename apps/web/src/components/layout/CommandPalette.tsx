/**
 * Command palette (⌘K).
 *
 * Two modes in one surface: with no query it lists navigation and actions;
 * with a query it searches the workspace through the real search endpoint,
 * debounced, and reports the retrieval mode the server actually used.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SearchHit } from "@workos/shared";
import { api } from "../../lib/api.js";
import { useDebounced } from "../../lib/hooks.js";
import { Icon, type IconName } from "../ui/index.js";
import styles from "./layout.module.css";

interface Command {
  id: string;
  title: string;
  meta?: string;
  icon: IconName;
  group: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  canUseAi,
}: {
  open: boolean;
  onClose: () => void;
  canUseAi: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<string | null>(null);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const debouncedQuery = useDebounced(query, 180);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setHits([]);
    setSearchMode(null);
    setSearchNotice(null);
    // Focus after the open animation starts, so the caret lands correctly.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) {
      setHits([]);
      setSearchMode(null);
      setSearchNotice(null);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    api
      .search({ q: trimmed, limit: 12 }, controller.signal)
      .then((response) => {
        setHits(response.hits);
        setSearchMode(response.mode);
        setSearchNotice(response.notice);
        setSearching(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setHits([]);
        setSearching(false);
      });

    return () => controller.abort();
  }, [debouncedQuery, open]);

  const go = (path: string) => {
    navigate(path);
    onClose();
  };

  const commands = useMemo<Command[]>(() => {
    const items: Command[] = [
      { id: "nav-home", title: "Home", icon: "home", group: "Navigate", run: () => go("/") },
      { id: "nav-projects", title: "Projects", icon: "board", group: "Navigate", run: () => go("/projects") },
      { id: "nav-tasks", title: "My tasks", icon: "list", group: "Navigate", run: () => go("/my-tasks") },
      { id: "nav-docs", title: "Documents", icon: "doc", group: "Navigate", run: () => go("/docs") },
      { id: "nav-meetings", title: "Meetings", icon: "mic", group: "Navigate", run: () => go("/meetings") },
      { id: "nav-insights", title: "Insights", icon: "activity", group: "Navigate", run: () => go("/insights") },
      { id: "nav-activity", title: "Activity feed", icon: "activity", group: "Navigate", run: () => go("/activity") },
      {
        id: "action-project",
        title: "New project",
        meta: "Create a project",
        icon: "plus",
        group: "Create",
        run: () => go("/projects?new=1"),
      },
      {
        id: "action-doc",
        title: "New document",
        icon: "plus",
        group: "Create",
        run: () => go("/docs?new=1"),
      },
      {
        id: "action-meeting",
        title: "New meeting",
        icon: "plus",
        group: "Create",
        run: () => go("/meetings?new=1"),
      },
    ];

    if (canUseAi) {
      items.push(
        {
          id: "ai-chat",
          title: "Ask the AI about this workspace",
          icon: "sparkle",
          group: "AI",
          run: () => go("/ai"),
        },
        {
          id: "ai-plan",
          title: "Turn a brief into a project plan",
          icon: "sparkle",
          group: "AI",
          run: () => go("/ai/plan"),
        },
        {
          id: "ai-actions",
          title: "Review pending AI actions",
          icon: "shield",
          group: "AI",
          run: () => go("/ai/actions"),
        },
      );
    }

    items.push(
      { id: "nav-members", title: "Members", icon: "users", group: "Settings", run: () => go("/settings/members") },
      { id: "nav-integrations", title: "Integrations", icon: "link", group: "Settings", run: () => go("/settings/integrations") },
      { id: "nav-audit", title: "Audit log", icon: "shield", group: "Settings", run: () => go("/settings/audit") },
      { id: "nav-settings", title: "Workspace settings", icon: "settings", group: "Settings", run: () => go("/settings") },
    );

    return items;
  }, [canUseAi, navigate]);

  const filteredCommands = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return commands;
    return commands.filter(
      (command) =>
        command.title.toLowerCase().includes(trimmed) ||
        command.group.toLowerCase().includes(trimmed),
    );
  }, [commands, query]);

  const searchItems = useMemo<Command[]>(
    () =>
      hits.map((hit) => ({
        id: `hit-${hit.entityType}-${hit.entityId}`,
        title: hit.title,
        meta: hit.snippet.replace(/\s+/g, " ").slice(0, 90),
        icon: ({ task: "list", document: "doc", meeting: "mic", project: "board" } as const)[
          hit.entityType
        ],
        group: searchMode === "keyword" ? "Results (keyword)" : `Results (${searchMode ?? "search"})`,
        run: () => go(hit.url),
      })),
    [hits, searchMode, navigate],
  );

  const items = useMemo(
    () => [...searchItems, ...filteredCommands],
    [searchItems, filteredCommands],
  );

  // Keep the cursor inside the list as results change.
  useEffect(() => {
    setCursor((current) => (current >= items.length ? Math.max(0, items.length - 1) : current));
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((c) => Math.min(items.length - 1, c + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        items[cursor]?.run();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, items, cursor, onClose]);

  // Scroll the highlighted row into view for keyboard navigation.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const grouped: Array<{ group: string; items: Array<Command & { index: number }> }> = [];
  items.forEach((item, index) => {
    const last = grouped[grouped.length - 1];
    if (last && last.group === item.group) last.items.push({ ...item, index });
    else grouped.push({ group: item.group, items: [{ ...item, index }] });
  });

  return (
    <div
      className={styles.paletteOverlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.palette} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className={styles.paletteInputRow}>
          <Icon name="search" size={17} style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={inputRef}
            className={styles.paletteInput}
            placeholder="Search tasks, documents, meetings — or jump to a page"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            aria-label="Search or run a command"
          />
          {searching && <span className="spinner" style={{ color: "var(--text-tertiary)" }} />}
        </div>

        <div className={styles.paletteResults} ref={listRef}>
          {items.length === 0 ? (
            <div style={{ padding: "var(--space-8)", textAlign: "center" }} className="text-sm text-secondary">
              {query.trim().length >= 2
                ? `Nothing matches "${query.trim()}".`
                : "Type to search this workspace."}
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.group} className={styles.paletteGroup}>
                <div className={styles.paletteGroupLabel}>{group.group}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-index={item.index}
                    className={`${styles.paletteItem} ${
                      item.index === cursor ? styles.paletteItemActive : ""
                    }`}
                    onMouseEnter={() => setCursor(item.index)}
                    onClick={item.run}
                  >
                    <span className={styles.paletteItemIcon}>
                      <Icon name={item.icon} size={14} />
                    </span>
                    <span className={styles.paletteItemBody}>
                      <span className={styles.paletteItemTitle}>{item.title}</span>
                      {item.meta && <span className={styles.paletteItemMeta}>{item.meta}</span>}
                    </span>
                    {item.index === cursor && (
                      <Icon name="arrow-right" size={13} style={{ color: "var(--text-tertiary)" }} />
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className={styles.paletteFooter}>
          <span className={styles.paletteHint}>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className={styles.paletteHint}>
            <kbd>↵</kbd> open
          </span>
          <span className={styles.paletteHint}>
            <kbd>esc</kbd> close
          </span>
          {/* The server says which retrieval path ran; we repeat it verbatim. */}
          {searchNotice && (
            <span style={{ marginLeft: "auto", textAlign: "right" }}>{searchNotice}</span>
          )}
        </div>
      </div>
    </div>
  );
}
