/**
 * Approval queue.
 *
 * This screen is where the product's central promise is kept: the AI proposes,
 * a person decides. Each card shows the exact payload that will be executed,
 * allows editing it before approving, and afterwards shows what actually
 * happened — including failures, which are never dressed up as success.
 */
import { useEffect, useState } from "react";
import type { AiAction, AiActionStatus } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useRealtimeEvent } from "../lib/realtime.js";
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
  Tabs,
  useToast,
} from "../components/ui/index.js";
import styles from "./ai.module.css";

type Filter = "pending" | "all";

export function AiActionsPage() {
  const workspace = useWorkspace();
  const [filter, setFilter] = useState<Filter>("pending");
  const [actions, setActions] = useState<AiAction[]>([]);

  const loaded = useAsync(
    () =>
      api.ai.actions({
        status: filter === "pending" ? "pending_approval" : undefined,
        limit: 100,
      }),
    [workspace.id, filter],
  );

  useEffect(() => {
    if (loaded.data) setActions(loaded.data.actions);
  }, [loaded.data]);

  useRealtimeEvent("ai.action.created", (event) => {
    setActions((prev) =>
      prev.some((action) => action.id === event.action.id) ? prev : [event.action, ...prev],
    );
  });

  useRealtimeEvent("ai.action.decided", (event) => {
    setActions((prev) =>
      filter === "pending"
        ? prev.filter((action) => action.id !== event.action.id)
        : prev.map((action) => (action.id === event.action.id ? event.action : action)),
    );
  });

  const pendingCount = loaded.data?.pendingCount ?? 0;

  return (
    <div className="fade-in">
      <PageHeader
        title="AI approvals"
        subtitle="Every change the AI wants to make waits here. Nothing is applied until you approve it, and every decision is recorded in the audit log."
        badge={pendingCount > 0 ? <span className="badge badge-accent">{pendingCount} waiting</span> : undefined}
      />

      <div style={{ marginBottom: "var(--space-5)" }}>
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "pending", label: "Awaiting decision", count: pendingCount },
            { id: "all", label: "History" },
          ]}
        />
      </div>

      {loaded.loading && actions.length === 0 ? (
        <LoadingRows rows={3} />
      ) : loaded.error ? (
        <ErrorState error={loaded.error} onRetry={loaded.reload} />
      ) : actions.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="shield"
            title={filter === "pending" ? "Nothing waiting for you" : "No AI actions yet"}
            body={
              filter === "pending"
                ? "When the AI proposes a change — creating tasks, applying a plan, reassigning work — it will appear here for a decision."
                : "Ask the AI to do something, or generate a plan from a brief, and the proposals will be recorded here."
            }
          />
        </div>
      ) : (
        <div className="stack gap-4">
          {actions.map((action) => (
            <PendingActionCard
              key={action.id}
              action={action}
              onDecided={(updated) =>
                setActions((prev) =>
                  filter === "pending"
                    ? prev.filter((candidate) => candidate.id !== updated.id)
                    : prev.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_BADGE: Record<AiActionStatus, { label: string; className: string }> = {
  pending_approval: { label: "Awaiting approval", className: "badge badge-accent" },
  approved: { label: "Approved", className: "badge badge-info" },
  rejected: { label: "Rejected", className: "badge" },
  executed: { label: "Applied", className: "badge badge-success" },
  failed: { label: "Failed", className: "badge badge-danger" },
};

export function PendingActionCard({
  action,
  onDecided,
}: {
  action: AiAction;
  onDecided: (action: AiAction) => void;
}) {
  const toast = useToast();
  const workspace = useWorkspace();
  const [showPayload, setShowPayload] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [note, setNote] = useState("");

  const decide = useMutation(
    async (decision: "approve" | "reject", payloadOverride?: Record<string, unknown>) => {
      const result = await api.ai.decide(action.id, {
        decision,
        note: note.trim() || undefined,
        payloadOverride,
      });

      // The toast reports what actually happened, not what was requested.
      if (result.action.status === "executed") {
        toast.success("Applied", result.output?.split("\n")[0] ?? undefined);
      } else if (result.action.status === "failed") {
        toast.error("The action failed", result.action.error ?? undefined);
      } else if (result.action.status === "rejected") {
        toast.info("Rejected", "Nothing was changed.");
      }

      onDecided(result.action);
      return result;
    },
  );

  const pending = action.status === "pending_approval";
  const badge = STATUS_BADGE[action.status];
  const canDecide = workspace.role !== "guest";

  const summary = describePayload(action);

  return (
    <article className={`${styles.actionCard} ${pending ? styles.actionPending : ""}`}>
      <div className={styles.actionHeader}>
        <span className={styles.actionTool}>{action.tool}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.actionSummary}>{action.summary}</div>
          <div className={styles.actionMeta}>
            Proposed {relativeTime(action.createdAt)}
            {action.requestedBy ? ` · requested by ${action.requestedBy.name}` : ""}
            {action.decidedBy ? ` · decided by ${action.decidedBy.name}` : ""}
            {action.decisionNote ? ` · “${action.decisionNote}”` : ""}
          </div>
          {summary.length > 0 && (
            <ul
              className="text-xs text-secondary"
              style={{ marginTop: "var(--space-2)", display: "grid", gap: 2 }}
            >
              {summary.map((line, index) => (
                <li key={index} className="row gap-2">
                  <Icon name="dot" size={6} style={{ flexShrink: 0 }} />
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className={badge.className}>{badge.label}</span>
      </div>

      {showPayload && (
        <pre className={styles.actionPayload}>{JSON.stringify(action.payload, null, 2)}</pre>
      )}

      {decide.error && (
        <div style={{ padding: "0 var(--space-4) var(--space-4)" }}>
          <Notice tone="danger">{errorMessage(decide.error)}</Notice>
        </div>
      )}

      {(action.status === "executed" || action.status === "failed") && (
        <div
          className={`${styles.actionOutcome} ${
            action.status === "executed" ? styles.actionOutcomeOk : styles.actionOutcomeFailed
          }`}
        >
          <strong>{action.status === "executed" ? "Result: " : "Error: "}</strong>
          {action.status === "executed"
            ? String((action.result as { output?: string } | null)?.output ?? "Applied.")
            : (action.error ?? "Unknown error")}
        </div>
      )}

      <div className={styles.actionFooter}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowPayload((open) => !open)}
        >
          <Icon name={showPayload ? "chevron-down" : "chevron-right"} size={13} />
          {showPayload ? "Hide" : "Show"} exact payload
        </button>

        <span className="spacer" />

        {pending && canDecide && (
          <>
            <input
              className="input"
              style={{ height: 26, width: 180, fontSize: "var(--text-xs)" }}
              placeholder="Note (optional)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-label="Decision note"
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setEditOpen(true)}
              disabled={decide.pending}
            >
              <Icon name="pencil" size={12} />
              Edit &amp; approve
            </button>
            <button
              type="button"
              className="btn btn-danger-ghost btn-sm"
              onClick={() => void decide.run("reject")}
              disabled={decide.pending}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void decide.run("approve")}
              disabled={decide.pending}
            >
              {decide.pending && <span className="spinner" />}
              Approve
            </button>
          </>
        )}

        {pending && !canDecide && (
          <span className="text-xs text-tertiary">Guests cannot approve AI actions.</span>
        )}

        {action.requestedBy && !pending && <Avatar user={action.requestedBy} size={20} />}
      </div>

      <EditPayloadDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        action={action}
        pending={decide.pending}
        onApprove={(payload) => {
          setEditOpen(false);
          void decide.run("approve", payload);
        }}
      />
    </article>
  );
}

/** Human-readable highlights from the payload, so the JSON is optional reading. */
function describePayload(action: AiAction): string[] {
  const payload = action.payload as Record<string, unknown>;

  if (action.tool === "create_tasks" && Array.isArray(payload.tasks)) {
    return (payload.tasks as Array<{ title?: string; priority?: string; assignee?: string }>)
      .slice(0, 8)
      .map(
        (task) =>
          `${task.title ?? "(untitled)"}${task.priority && task.priority !== "none" ? ` — ${task.priority}` : ""}${
            task.assignee ? ` → ${task.assignee}` : ""
          }`,
      );
  }

  if (action.tool === "apply_project_plan") {
    const plan = payload.plan as
      | { tasks?: unknown[]; milestones?: Array<{ name?: string }>; projectName?: string }
      | undefined;
    const lines: string[] = [];
    if (plan?.projectName) lines.push(`Project: ${plan.projectName}`);
    if (plan?.milestones?.length) {
      lines.push(
        `Milestones: ${plan.milestones.map((m) => m.name ?? "?").slice(0, 5).join(", ")}`,
      );
    }
    if (plan?.tasks?.length) lines.push(`${plan.tasks.length} tasks, with dependency links`);
    return lines;
  }

  if (action.tool === "update_task" || action.tool === "assign_task") {
    return Object.entries(payload)
      .filter(([key]) => key !== "task")
      .map(([key, value]) => `${key}: ${String(value)}`);
  }

  if (action.tool === "create_document") {
    const markdown = typeof payload.markdown === "string" ? payload.markdown : "";
    return [`${markdown.length} characters of content`];
  }

  return [];
}

function EditPayloadDialog({
  open,
  onClose,
  action,
  pending,
  onApprove,
}: {
  open: boolean;
  onClose: () => void;
  action: AiAction;
  pending: boolean;
  onApprove: (payload: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText(JSON.stringify(action.payload, null, 2));
      setParseError(null);
    }
  }, [open, action.payload]);

  const submit = () => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("The payload must be a JSON object.");
        return;
      }
      setParseError(null);
      onApprove(parsed as Record<string, unknown>);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "That is not valid JSON.");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Edit before approving"
      description="Your edits are validated against the tool's schema before anything runs. A payload that does not fit is rejected, and the proposal stays pending."
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={pending}>
            {pending && <span className="spinner" />}
            Approve with these changes
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        {parseError && <Notice tone="danger">{parseError}</Notice>}
        <textarea
          className="textarea mono"
          style={{ minHeight: 320, fontSize: 12, lineHeight: 1.5 }}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          aria-label="Action payload"
        />
      </div>
    </Modal>
  );
}
