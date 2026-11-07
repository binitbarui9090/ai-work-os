import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, relativeTime, useAsync, useDebounced, useMutation } from "../lib/hooks.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Modal,
  Notice,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

export function DocumentsPage() {
  const workspace = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const debouncedQuery = useDebounced(query, 220);

  const documents = useAsync(
    () =>
      api.documents.list({
        q: debouncedQuery.trim() || undefined,
        projectId: projectFilter || undefined,
      }),
    [workspace.id, debouncedQuery, projectFilter],
  );
  const projects = useAsync(() => api.projects.list(), [workspace.id]);

  const createOpen = searchParams.get("new") === "1";
  const setCreateOpen = (open: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (open) next.set("new", "1");
    else next.delete("new");
    setSearchParams(next, { replace: true });
  };

  const canCreate = workspace.role !== "guest";
  const items = documents.data?.documents ?? [];

  return (
    <div className="fade-in">
      <PageHeader
        title="Documents"
        subtitle="Specs, notes and decisions. Everything here is searchable, and the AI reads it when answering questions."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={14} />
              New document
            </button>
          ) : undefined
        }
      />

      <div className={styles.toolbar}>
        <input
          className={`input ${styles.toolbarSearch}`}
          placeholder="Search documents…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search documents"
        />
        <select
          className={`select ${styles.toolbarSelect}`}
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {(projects.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      {documents.loading && items.length === 0 ? (
        <LoadingRows rows={4} />
      ) : documents.error ? (
        <ErrorState error={documents.error} onRetry={documents.reload} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="doc"
            title={debouncedQuery ? "Nothing matches that search" : "No documents yet"}
            body={
              debouncedQuery
                ? "Try fewer words, or search from the command palette to cover tasks and meetings too."
                : "Write the project plan, the architecture note, the thing everyone keeps re-explaining."
            }
            action={
              canCreate && !debouncedQuery ? (
                <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                  New document
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="card">
          {items.map((document) => (
            <Link
              key={document.id}
              to={`/docs/${document.id}`}
              className={styles.taskRow}
              style={{ color: "inherit" }}
            >
              <span style={{ width: 20, textAlign: "center", flexShrink: 0 }}>
                {document.icon ?? <Icon name="doc" size={15} style={{ color: "var(--text-tertiary)" }} />}
              </span>
              <span className={styles.taskTitle}>{document.title}</span>
              <span className={styles.taskMeta}>
                <span className="text-xs text-tertiary">v{document.version}</span>
                <span className="text-xs text-tertiary">{relativeTime(document.updatedAt)}</span>
                <Avatar user={document.updatedBy} size={20} />
              </span>
            </Link>
          ))}
        </div>
      )}

      <CreateDocumentDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateDocumentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const workspace = useWorkspace();
  const projects = useAsync(() => api.projects.list(), [workspace.id]);

  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setProjectId("");
  }, [open]);

  const create = useMutation(async () => {
    const result = await api.documents.create({
      title: title.trim(),
      projectId: projectId || null,
      content: [{ type: "paragraph", text: "" }],
    });
    toast.success("Document created");
    onClose();
    navigate(`/docs/${result.document.id}`);
    return result;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New document"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void create.run()}
            disabled={create.pending || title.trim().length < 2}
          >
            {create.pending && <span className="spinner" />}
            Create
          </button>
        </>
      }
    >
      <div className="stack gap-4">
        {create.error && <Notice tone="danger">{errorMessage(create.error)}</Notice>}

        <div className="field">
          <label className="label" htmlFor="doc-title">
            Title
          </label>
          <input
            id="doc-title"
            className="input"
            placeholder="Architecture decision: event bus"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="doc-project">
            Project
          </label>
          <select
            id="doc-project"
            className="select"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Workspace-wide</option>
            {(projects.data?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Project documents are only visible to people with access to that project.
          </span>
        </div>
      </div>
    </Modal>
  );
}
