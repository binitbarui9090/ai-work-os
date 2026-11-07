/**
 * Task detail.
 *
 * Title and description save on blur with a visible saved/saving state, so
 * there is no ambiguity about whether an edit landed. Everything else is a
 * single-field control that writes immediately.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@workos/shared";
import { api, uploadFile } from "../lib/api.js";
import {
  errorMessage,
  formatBytes,
  formatDateTime,
  relativeTime,
  statusLabel,
  useAsync,
  useMutation,
} from "../lib/hooks.js";
import { useChannel, usePresenceLocation, useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { CommentThread } from "../components/CommentThread.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import { DueDate, TaskLabels } from "../components/TaskViews.js";
import {
  Avatar,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Modal,
  Notice,
  StatusBadge,
  useToast,
} from "../components/ui/index.js";
import { CreateTaskDialog } from "./TaskDialog.js";
import styles from "./pages.module.css";

export function TaskPage() {
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const toast = useToast();

  const loaded = useAsync(() => api.tasks.get(taskId), [taskId]);
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);
  const [task, setTask] = useState<Task | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addSubtask, setAddSubtask] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  useEffect(() => {
    if (loaded.data) setTask(loaded.data.task);
  }, [loaded.data]);

  useChannel(task ? `task:${task.id}` : null);
  usePresenceLocation(task ? `task:${task.id}` : null);

  useRealtimeEvent("task.updated", (event) => {
    if (event.task.id === taskId) setTask(event.task);
  });

  const update = useMutation(async (patch: Record<string, unknown>) => {
    const result = await api.tasks.update(taskId, patch);
    setTask(result.task);
    return result;
  });

  const remove = useMutation(async () => {
    await api.tasks.remove(taskId);
    toast.success("Task deleted");
    navigate(task ? `/projects/${task.projectId}` : "/projects");
  });

  if (loaded.loading && !task) {
    return (
      <>
        <PageHeader title="Loading task" />
        <LoadingRows rows={4} />
      </>
    );
  }

  if (loaded.error || !task) {
    return <ErrorState error={loaded.error} onRetry={loaded.reload} />;
  }

  const canEdit = workspace.role !== "guest";
  const attachments = loaded.data?.attachments ?? [];

  return (
    <div className="fade-in">
      <PageHeader
        breadcrumbs={[
          { label: "Projects", to: "/projects" },
          { label: task.projectName, to: `/projects/${task.projectId}` },
          { label: task.reference },
        ]}
        title={
          <EditableTitle
            value={task.title}
            disabled={!canEdit}
            onSave={(title) => update.run({ title })}
          />
        }
        actions={
          canEdit ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAddSubtask(true)}
              >
                <Icon name="plus" size={13} />
                Subtask
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setLinkOpen(true)}
              >
                <Icon name="link" size={13} />
                Add dependency
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete task"
              >
                <Icon name="trash" size={14} />
              </button>
            </>
          ) : undefined
        }
      />

      {update.error && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Notice tone="danger">{errorMessage(update.error)}</Notice>
        </div>
      )}

      {task.isBlocked && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Notice tone="warning" title="This task is blocked">
            Waiting on{" "}
            {task.blockedBy
              .filter((link) => link.type === "blocks" && link.status !== "done" && link.status !== "canceled")
              .map((link, index, all) => (
                <span key={link.id}>
                  <Link to={`/tasks/${link.id}`}>{link.reference}</Link>
                  {index < all.length - 1 ? ", " : ""}
                </span>
              ))}
            .
          </Notice>
        </div>
      )}

      <div className={styles.detail}>
        <div className={styles.detailMain}>
          <section style={{ marginBottom: "var(--space-6)" }}>
            <SectionHeader title="Description" />
            <EditableBody
              value={task.description ?? ""}
              disabled={!canEdit}
              onSave={(description) => update.run({ description: description || null })}
            />
          </section>

          {task.subtaskCount > 0 && (
            <section style={{ marginBottom: "var(--space-6)" }}>
              <SectionHeader
                title={`Subtasks (${task.doneSubtaskCount}/${task.subtaskCount})`}
                action={
                  canEdit ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setAddSubtask(true)}
                    >
                      <Icon name="plus" size={13} />
                      Add
                    </button>
                  ) : undefined
                }
              />
              <SubtaskList parentTaskId={task.id} />
            </section>
          )}

          {attachments.length > 0 && (
            <section style={{ marginBottom: "var(--space-6)" }}>
              <SectionHeader title="Attachments" />
              <div className="card">
                {attachments.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={attachment.url}
                    className={styles.taskRow}
                    style={{ color: "inherit" }}
                  >
                    <Icon name="paperclip" size={14} style={{ color: "var(--text-tertiary)" }} />
                    <span className={styles.taskTitle}>{attachment.filename}</span>
                    <span className="text-xs text-tertiary">
                      {formatBytes(attachment.sizeBytes)}
                    </span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {canEdit && (
            <section style={{ marginBottom: "var(--space-6)" }}>
              <AttachmentUploader taskId={task.id} onUploaded={() => loaded.reload()} />
            </section>
          )}

          <section>
            <SectionHeader title={`Comments (${task.commentCount})`} />
            <CommentThread
              entityType="task"
              entityId={task.id}
              members={members.data?.members ?? []}
            />
          </section>
        </div>

        <aside className={styles.detailSide}>
          <div className={styles.sideCard}>
            <div className={styles.detailField}>
              <span className={styles.detailFieldLabel}>Status</span>
              {canEdit ? (
                <select
                  className="select"
                  value={task.status}
                  onChange={(event) => void update.run({ status: event.target.value as TaskStatus })}
                  aria-label="Status"
                >
                  {TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={task.status} />
              )}
            </div>

            <div className={styles.detailField}>
              <span className={styles.detailFieldLabel}>Assignee</span>
              {canEdit ? (
                <select
                  className="select"
                  value={task.assignee?.id ?? ""}
                  onChange={(event) =>
                    void update.run({ assigneeId: event.target.value || null })
                  }
                  aria-label="Assignee"
                >
                  <option value="">Unassigned</option>
                  {(members.data?.members ?? []).map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="row gap-2">
                  <Avatar user={task.assignee} size={20} />
                  {task.assignee?.name ?? "Unassigned"}
                </span>
              )}
            </div>

            <div className={styles.detailField}>
              <span className={styles.detailFieldLabel}>Priority</span>
              {canEdit ? (
                <select
                  className="select"
                  value={task.priority}
                  onChange={(event) =>
                    void update.run({ priority: event.target.value as TaskPriority })
                  }
                  aria-label="Priority"
                >
                  {TASK_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {statusLabel(priority)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={styles.detailFieldValue}>{statusLabel(task.priority)}</span>
              )}
            </div>

            <div className={styles.detailField}>
              <span className={styles.detailFieldLabel}>Due date</span>
              {canEdit ? (
                <input
                  className="input"
                  type="date"
                  value={task.dueDate ?? ""}
                  onChange={(event) => void update.run({ dueDate: event.target.value || null })}
                  aria-label="Due date"
                />
              ) : (
                <span className={styles.detailFieldValue}>
                  <DueDate value={task.dueDate} done={task.status === "done"} />
                </span>
              )}
            </div>

            {task.estimateHours !== null && (
              <div className={styles.detailField}>
                <span className={styles.detailFieldLabel}>Estimate</span>
                <span className={styles.detailFieldValue}>{task.estimateHours}h</span>
              </div>
            )}

            {task.labels.length > 0 && (
              <div className={styles.detailField}>
                <span className={styles.detailFieldLabel}>Labels</span>
                <TaskLabels labels={task.labels} />
              </div>
            )}
          </div>

          {(task.blockedBy.length > 0 || task.blocking.length > 0) && (
            <div className={styles.sideCard}>
              {task.blockedBy.length > 0 && (
                <div className={styles.detailField}>
                  <span className={styles.detailFieldLabel}>Blocked by</span>
                  {task.blockedBy.map((link) => (
                    <Link key={link.id} to={`/tasks/${link.id}`} className={styles.dependencyRow}>
                      <span className={styles.dependencyRef}>{link.reference}</span>
                      <span className="truncate" style={{ flex: 1 }}>
                        {link.title}
                      </span>
                      <StatusBadge status={link.status} />
                    </Link>
                  ))}
                </div>
              )}

              {task.blocking.length > 0 && (
                <div className={styles.detailField}>
                  <span className={styles.detailFieldLabel}>Blocking</span>
                  {task.blocking.map((link) => (
                    <Link key={link.id} to={`/tasks/${link.id}`} className={styles.dependencyRow}>
                      <span className={styles.dependencyRef}>{link.reference}</span>
                      <span className="truncate" style={{ flex: 1 }}>
                        {link.title}
                      </span>
                      <StatusBadge status={link.status} />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={styles.sideCard}>
            <div className="text-xs text-tertiary stack gap-2">
              <span>
                Created {relativeTime(task.createdAt)}
                {task.creator ? ` by ${task.creator.name}` : ""}
                {task.createdByAi ? " (AI, after approval)" : ""}
              </span>
              <span>Updated {relativeTime(task.updatedAt)}</span>
              {task.completedAt && <span>Completed {formatDateTime(task.completedAt)}</span>}
            </div>
          </div>
        </aside>
      </div>

      <CreateTaskDialog
        open={addSubtask}
        onClose={() => setAddSubtask(false)}
        projectId={task.projectId}
        parentTaskId={task.id}
        onCreated={() => loaded.reload()}
      />

      <AddDependencyDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        task={task}
        onLinked={() => loaded.reload()}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove.run()}
        title={`Delete ${task.reference}?`}
        body="This removes the task, its comments and its dependency links. It cannot be undone."
        confirmLabel="Delete task"
        destructive
        pending={remove.pending}
      />
    </div>
  );
}

function EditableTitle({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled?: boolean;
  onSave: (value: string) => void | Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setDraft(value), [value]);

  // Grow to fit, so a long title is never cut off.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      setDraft(value);
      return;
    }
    setState("saving");
    await onSave(trimmed);
    setState("saved");
    window.setTimeout(() => setState("idle"), 1500);
  };

  return (
    <span style={{ flex: 1, minWidth: 0 }}>
      <textarea
        ref={ref}
        className={styles.editableTitle}
        rows={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        aria-label="Task title"
      />
      {state !== "idle" && (
        <span className={styles.saveHint}>
          {state === "saving" ? (
            <>
              <span className="spinner" style={{ width: 10, height: 10 }} /> Saving
            </>
          ) : (
            <>
              <Icon name="check" size={11} /> Saved
            </>
          )}
        </span>
      )}
    </span>
  );
}

function EditableBody({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled?: boolean;
  onSave: (value: string) => void | Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => setDraft(value), [value]);

  const commit = async () => {
    if (draft === value) return;
    setState("saving");
    await onSave(draft);
    setState("saved");
    window.setTimeout(() => setState("idle"), 1500);
  };

  if (disabled) {
    return value ? (
      <div className="prose" style={{ whiteSpace: "pre-wrap" }}>
        {value}
      </div>
    ) : (
      <p className="text-sm text-tertiary">No description.</p>
    );
  }

  return (
    <div>
      <textarea
        className={styles.editableBody}
        placeholder="Add a description… what needs doing, and how you will know it is done."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        aria-label="Task description"
      />
      <span className={styles.saveHint}>
        {state === "saving" ? (
          <>
            <span className="spinner" style={{ width: 10, height: 10 }} /> Saving
          </>
        ) : state === "saved" ? (
          <>
            <Icon name="check" size={11} /> Saved
          </>
        ) : draft !== value ? (
          "Unsaved — click outside to save"
        ) : (
          ""
        )}
      </span>
    </div>
  );
}

function SubtaskList({ parentTaskId }: { parentTaskId: string }) {
  const subtasks = useAsync(
    () => api.tasks.list({ parentTaskId, includeDone: true }),
    [parentTaskId],
  );

  const toggle = useMutation(async (task: Task) => {
    await api.tasks.update(task.id, { status: task.status === "done" ? "todo" : "done" });
    subtasks.reload();
  });

  if (subtasks.loading) return <LoadingRows rows={2} />;
  if (subtasks.error) return <ErrorState error={subtasks.error} onRetry={subtasks.reload} compact />;

  const items = subtasks.data?.tasks ?? [];
  if (items.length === 0) {
    return <EmptyState icon="list" title="No subtasks" compact />;
  }

  return (
    <div className={styles.taskList}>
      {items.map((task) => (
        <div key={task.id} className={styles.taskRow}>
          <button
            type="button"
            className={`${styles.taskStatusToggle} ${
              task.status === "done" ? styles.taskStatusToggleDone : ""
            }`}
            onClick={() => void toggle.run(task)}
            aria-label={task.status === "done" ? "Reopen subtask" : "Complete subtask"}
          >
            <Icon name="check" size={11} strokeWidth={2.4} />
          </button>
          <Link to={`/tasks/${task.id}`} style={{ flex: 1, minWidth: 0, color: "inherit" }}>
            <span className={`${styles.taskTitle} ${task.status === "done" ? styles.taskTitleDone : ""}`}>
              {task.title}
            </span>
          </Link>
          <Avatar user={task.assignee} size={20} />
        </div>
      ))}
    </div>
  );
}

function AddDependencyDialog({
  open,
  onClose,
  task,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  task: Task;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<"blocked-by" | "blocks">("blocked-by");

  const candidates = useAsync(
    () => api.tasks.list({ projectId: task.projectId, includeDone: true, limit: 200 }),
    [task.projectId, open],
  );

  const link = useMutation(async (otherId: string) => {
    await api.tasks.addDependency({
      blockingTaskId: direction === "blocked-by" ? otherId : task.id,
      blockedTaskId: direction === "blocked-by" ? task.id : otherId,
      type: "blocks",
    });
    toast.success("Dependency added");
    onLinked();
    onClose();
  });

  const existing = new Set([
    task.id,
    ...task.blockedBy.map((l) => l.id),
    ...task.blocking.map((l) => l.id),
  ]);

  const options = (candidates.data?.tasks ?? [])
    .filter((candidate) => !existing.has(candidate.id))
    .filter((candidate) =>
      query.trim()
        ? candidate.title.toLowerCase().includes(query.toLowerCase()) ||
          candidate.reference.toLowerCase().includes(query.toLowerCase())
        : true,
    )
    .slice(0, 20);

  return (
    <Modal open={open} onClose={onClose} title="Add a dependency">
      <div className="stack gap-4">
        {link.error && <Notice tone="danger">{errorMessage(link.error)}</Notice>}

        <div className="field">
          <span className="label">Relationship</span>
          <select
            className="select"
            value={direction}
            onChange={(event) => setDirection(event.target.value as "blocked-by" | "blocks")}
          >
            <option value="blocked-by">{task.reference} is blocked by…</option>
            <option value="blocks">{task.reference} blocks…</option>
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="dependency-search">
            Find a task in {task.projectName}
          </label>
          <input
            id="dependency-search"
            className="input"
            placeholder="Search by title or reference"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>

        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {candidates.loading ? (
            <LoadingRows rows={3} />
          ) : options.length === 0 ? (
            <p className="text-sm text-secondary" style={{ padding: "var(--space-4)" }}>
              No other tasks available to link.
            </p>
          ) : (
            <div className={styles.taskList}>
              {options.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={styles.taskRow}
                  onClick={() => void link.run(candidate.id)}
                  disabled={link.pending}
                >
                  <span className={styles.taskReference}>{candidate.reference}</span>
                  <span className={styles.taskTitle}>{candidate.title}</span>
                  <StatusBadge status={candidate.status} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AttachmentUploader({
  taskId,
  onUploaded,
}: {
  taskId: string;
  onUploaded: () => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [storageConfigured, setStorageConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    void api.files
      .list("task", taskId)
      .then((response) => setStorageConfigured(response.storageConfigured))
      .catch(() => setStorageConfigured(false));
  }, [taskId]);

  const upload = useMutation(async (file: File) => {
    const attachment = await uploadFile(file, { entityType: "task", entityId: taskId });
    toast.success("File attached", attachment.filename);
    onUploaded();
    return attachment;
  });

  // Nothing is offered that cannot work: the server says whether storage exists.
  if (storageConfigured === false) {
    return (
      <Notice tone="neutral" title="File uploads are not configured">
        Set <code>STORAGE_PROVIDER=s3</code> and the <code>S3_*</code> variables in the API
        environment to enable attachments. <code>docker compose</code> runs a local MinIO for this.
      </Notice>
    );
  }
  if (storageConfigured === null) return null;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload.run(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => inputRef.current?.click()}
        disabled={upload.pending}
      >
        {upload.pending ? <span className="spinner" /> : <Icon name="paperclip" size={13} />}
        Attach a file
      </button>
      {upload.error && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <Notice tone="danger">{errorMessage(upload.error)}</Notice>
        </div>
      )}
    </div>
  );
}
