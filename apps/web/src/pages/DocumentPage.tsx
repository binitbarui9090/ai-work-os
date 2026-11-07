/**
 * Document editor.
 *
 * Blocks are edited in place. Saving is explicit about concurrency: the client
 * sends the version it loaded, and a 409 means someone else saved first — the
 * UI says so and offers to reload rather than clobbering their work.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { DocBlock, DocumentDetail } from "@workos/shared";
import { ApiRequestError, api } from "../lib/api.js";
import { errorMessage, relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useChannel, usePresenceLocation, useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { CommentThread } from "../components/CommentThread.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import {
  Avatar,
  ConfirmDialog,
  ErrorState,
  Icon,
  LoadingRows,
  Notice,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";
import docStyles from "./document.module.css";

const BLOCK_TYPES: Array<{ type: DocBlock["type"]; label: string; level?: 1 | 2 | 3 }> = [
  { type: "paragraph", label: "Text" },
  { type: "heading", label: "Heading 1", level: 1 },
  { type: "heading", label: "Heading 2", level: 2 },
  { type: "heading", label: "Heading 3", level: 3 },
  { type: "bullet", label: "Bulleted list" },
  { type: "numbered", label: "Numbered list" },
  { type: "todo", label: "To-do" },
  { type: "quote", label: "Quote" },
  { type: "code", label: "Code" },
  { type: "divider", label: "Divider" },
];

export function DocumentPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const toast = useToast();

  const loaded = useAsync(() => api.documents.get(documentId), [documentId]);
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);

  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [blocks, setBlocks] = useState<DocBlock[]>([]);
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setDocument(loaded.data.document);
    setBlocks(loaded.data.document.content.length > 0 ? loaded.data.document.content : [newBlock()]);
    setTitle(loaded.data.document.title);
    setDirty(false);
    setConflict(false);
  }, [loaded.data]);

  useChannel(documentId ? `document:${documentId}` : null);
  usePresenceLocation(documentId ? `document:${documentId}` : null);

  useRealtimeEvent("document.updated", (event) => {
    if (event.document.id !== documentId) return;
    if (!document) return;
    if (event.document.version <= document.version) return;
    // Someone else saved. Unsaved local edits are not thrown away silently.
    if (dirty) setConflict(true);
    else loaded.reload();
  });

  const save = useMutation(async () => {
    if (!document) return;
    try {
      const result = await api.documents.update(documentId, {
        title: title.trim() || "Untitled",
        content: blocks as unknown as Array<Record<string, unknown>>,
        baseVersion: document.version,
      });
      setDocument(result.document);
      setDirty(false);
      setConflict(false);
      return result;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConflict(true);
        return;
      }
      throw err;
    }
  });

  const remove = useMutation(async () => {
    await api.documents.remove(documentId);
    toast.success("Document archived");
    navigate("/docs");
  });

  // ⌘S saves, because people will try it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) void save.run();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, save]);

  const updateBlock = useCallback((index: number, patch: Partial<DocBlock>) => {
    setBlocks((prev) => prev.map((block, i) => (i === index ? { ...block, ...patch } : block)));
    setDirty(true);
  }, []);

  const insertBlock = useCallback((index: number, type: DocBlock["type"], level?: 1 | 2 | 3) => {
    setBlocks((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, { ...newBlock(), type, ...(level ? { level } : {}) });
      return next;
    });
    setDirty(true);
  }, []);

  const removeBlock = useCallback((index: number) => {
    setBlocks((prev) => (prev.length === 1 ? [newBlock()] : prev.filter((_, i) => i !== index)));
    setDirty(true);
  }, []);

  if (loaded.loading && !document) {
    return (
      <>
        <PageHeader title="Loading document" />
        <LoadingRows rows={5} />
      </>
    );
  }

  if (loaded.error || !document) {
    return <ErrorState error={loaded.error} onRetry={loaded.reload} />;
  }

  const canEdit = workspace.role !== "guest";

  return (
    <div className="fade-in">
      <PageHeader
        breadcrumbs={[{ label: "Documents", to: "/docs" }, { label: document.title }]}
        title={
          canEdit ? (
            <input
              className={styles.editableTitle}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
              aria-label="Document title"
            />
          ) : (
            document.title
          )
        }
        actions={
          <>
            <span className={styles.saveHint}>
              {save.pending ? (
                <>
                  <span className="spinner" style={{ width: 11, height: 11 }} /> Saving
                </>
              ) : dirty ? (
                "Unsaved changes"
              ) : (
                <>
                  <Icon name="check" size={12} /> Saved · v{document.version}
                </>
              )}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowVersions((open) => !open)}
            >
              History
            </button>
            {canEdit && (
              <>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void save.run()}
                  disabled={!dirty || save.pending}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Archive document"
                >
                  <Icon name="trash" size={14} />
                </button>
              </>
            )}
          </>
        }
      />

      {conflict && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Notice
            tone="warning"
            title="Someone else saved this document"
            action={
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => loaded.reload()}
              >
                Reload theirs
              </button>
            }
          >
            Your changes have not been saved. Reload to see their version — copy anything you need
            out of the editor first.
          </Notice>
        </div>
      )}

      {save.error && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Notice tone="danger">{errorMessage(save.error)}</Notice>
        </div>
      )}

      {showVersions && <VersionList documentId={documentId} />}

      <div className={docStyles.editor}>
        {blocks.map((block, index) => (
          <BlockEditor
            key={block.id}
            block={block}
            readOnly={!canEdit}
            onChange={(patch) => updateBlock(index, patch)}
            onInsert={(type, level) => insertBlock(index, type, level)}
            onRemove={() => removeBlock(index)}
          />
        ))}

        {canEdit && (
          <div className={docStyles.addBlockRow}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => insertBlock(blocks.length - 1, "paragraph")}
            >
              <Icon name="plus" size={13} />
              Add a block
            </button>
          </div>
        )}
      </div>

      <div style={{ marginTop: "var(--space-8)", maxWidth: "var(--prose-max)" }}>
        <SectionHeader title="Comments" />
        <CommentThread
          entityType="document"
          entityId={documentId}
          members={members.data?.members ?? []}
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove.run()}
        title="Archive this document?"
        body="It will be removed from listings and search. Its version history is kept."
        confirmLabel="Archive"
        destructive
        pending={remove.pending}
      />
    </div>
  );
}

function BlockEditor({
  block,
  readOnly,
  onChange,
  onInsert,
  onRemove,
}: {
  block: DocBlock;
  readOnly?: boolean;
  onChange: (patch: Partial<DocBlock>) => void;
  onInsert: (type: DocBlock["type"], level?: 1 | 2 | 3) => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Textareas grow to fit so nothing is hidden behind a scrollbar.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [block.text]);

  if (block.type === "divider") {
    return (
      <div className={docStyles.block}>
        <hr style={{ flex: 1, margin: "var(--space-3) 0" }} />
        {!readOnly && (
          <button
            type="button"
            className={docStyles.blockAction}
            onClick={onRemove}
            aria-label="Remove divider"
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
    );
  }

  const className = [
    docStyles.blockInput,
    block.type === "heading" && block.level === 1 ? docStyles.h1 : "",
    block.type === "heading" && block.level === 2 ? docStyles.h2 : "",
    block.type === "heading" && block.level === 3 ? docStyles.h3 : "",
    block.type === "code" ? docStyles.code : "",
    block.type === "quote" ? docStyles.quote : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={docStyles.block}>
      {!readOnly && (
        <div className={docStyles.blockControls}>
          <button
            type="button"
            className={docStyles.blockAction}
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Change block type"
          >
            <Icon name="plus" size={13} />
          </button>
          {menuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 30 }}
                onClick={() => setMenuOpen(false)}
              />
              <div className={`menu ${docStyles.blockMenu}`}>
                <div className="menu-label">Turn into</div>
                {BLOCK_TYPES.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      onChange({ type: option.type, level: option.level });
                      setMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
                <div className="menu-separator" />
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    onInsert("paragraph");
                    setMenuOpen(false);
                  }}
                >
                  <Icon name="plus" size={13} />
                  Insert block below
                </button>
                <button
                  type="button"
                  className="menu-item menu-item-danger"
                  onClick={() => {
                    onRemove();
                    setMenuOpen(false);
                  }}
                >
                  <Icon name="trash" size={13} />
                  Delete block
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {block.type === "todo" && (
        <input
          type="checkbox"
          className="checkbox"
          style={{ marginTop: 5 }}
          checked={Boolean(block.checked)}
          disabled={readOnly}
          onChange={(event) => onChange({ checked: event.target.checked })}
          aria-label="Done"
        />
      )}

      {(block.type === "bullet" || block.type === "numbered") && (
        <span className={docStyles.bulletMarker}>{block.type === "bullet" ? "•" : "1."}</span>
      )}

      <textarea
        ref={ref}
        className={className}
        rows={1}
        placeholder={placeholderFor(block)}
        value={block.text ?? ""}
        readOnly={readOnly}
        onChange={(event) => onChange({ text: event.target.value })}
        onKeyDown={(event) => {
          // Enter starts a new block of the same kind for list types.
          if (event.key === "Enter" && !event.shiftKey && block.type !== "code") {
            event.preventDefault();
            onInsert(
              block.type === "bullet" || block.type === "numbered" || block.type === "todo"
                ? block.type
                : "paragraph",
            );
          }
          // Backspace in an empty block removes it.
          if (event.key === "Backspace" && (block.text ?? "") === "") {
            event.preventDefault();
            onRemove();
          }
        }}
        aria-label={`${block.type} block`}
      />
    </div>
  );
}

function placeholderFor(block: DocBlock): string {
  switch (block.type) {
    case "heading":
      return `Heading ${block.level ?? 2}`;
    case "code":
      return "Code";
    case "quote":
      return "Quote";
    case "todo":
      return "To-do";
    case "bullet":
    case "numbered":
      return "List item";
    default:
      return "Write something, or press + to change the block type";
  }
}

function VersionList({ documentId }: { documentId: string }) {
  const versions = useAsync(() => api.documents.versions(documentId), [documentId]);

  return (
    <div className="panel" style={{ marginBottom: "var(--space-5)", maxWidth: "var(--prose-max)" }}>
      <div className="panel-header">
        <span className="panel-title">Version history</span>
      </div>
      {versions.loading ? (
        <LoadingRows rows={2} />
      ) : versions.error ? (
        <ErrorState error={versions.error} onRetry={versions.reload} compact />
      ) : (
        <div className="panel-body">
          <div className={styles.feed}>
            {(versions.data?.versions ?? []).map((version) => (
              <div key={version.version} className={styles.feedItem}>
                <span className="badge">v{version.version}</span>
                <span className={styles.feedText}>
                  {version.title}
                  {version.author && (
                    <span className="text-tertiary"> · {version.author}</span>
                  )}
                </span>
                <span className={styles.feedTime}>{relativeTime(version.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function newBlock(): DocBlock {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `block-${Math.random().toString(36).slice(2)}`,
    type: "paragraph",
    text: "",
  };
}

export { Avatar };
