import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, formatDateTime, useAsync, useMutation } from "../lib/hooks.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  AvatarGroup,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Modal,
  Notice,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

const PROCESSING_LABEL: Record<string, { label: string; className: string }> = {
  none: { label: "No transcript", className: "badge" },
  queued: { label: "Queued", className: "badge badge-info" },
  processing: { label: "Processing", className: "badge badge-info" },
  completed: { label: "Processed", className: "badge badge-success" },
  failed: { label: "Processing failed", className: "badge badge-danger" },
};

export function MeetingsPage() {
  const workspace = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const meetings = useAsync(() => api.meetings.list(), [workspace.id]);

  const createOpen = searchParams.get("new") === "1";
  const setCreateOpen = (open: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (open) next.set("new", "1");
    else next.delete("new");
    setSearchParams(next, { replace: true });
  };

  const canCreate = workspace.role !== "guest";
  const items = meetings.data?.meetings ?? [];

  return (
    <div className="fade-in">
      <PageHeader
        title="Meetings"
        subtitle="Upload a transcript and get the summary, the decisions and the action items — as suggestions you turn into tasks."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={14} />
              New meeting
            </button>
          ) : undefined
        }
      />

      {meetings.loading && items.length === 0 ? (
        <LoadingRows rows={3} />
      ) : meetings.error ? (
        <ErrorState error={meetings.error} onRetry={meetings.reload} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="mic"
            title="No meetings recorded"
            body="Add a meeting, paste the transcript, and the decisions and commitments stop living in someone's memory."
            action={
              canCreate ? (
                <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                  New meeting
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="card">
          {items.map((meeting) => {
            const status = PROCESSING_LABEL[meeting.processingStatus] ?? PROCESSING_LABEL.none!;
            return (
              <Link
                key={meeting.id}
                to={`/meetings/${meeting.id}`}
                className={styles.taskRow}
                style={{ color: "inherit" }}
              >
                <Icon name="mic" size={15} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className={styles.taskTitle} style={{ display: "block" }}>
                    {meeting.title}
                  </span>
                  <span className="text-xs text-tertiary">
                    {meeting.startsAt ? formatDateTime(meeting.startsAt) : "No date set"}
                    {meeting.durationMinutes ? ` · ${meeting.durationMinutes} min` : ""}
                  </span>
                </span>
                <span className={styles.taskMeta}>
                  <span className={status.className}>{status.label}</span>
                  {meeting.participants.length > 0 && (
                    <AvatarGroup users={meeting.participants} size={20} max={3} />
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <CreateMeetingDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateMeetingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const workspace = useWorkspace();
  const projects = useAsync(() => api.projects.list(), [workspace.id]);
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);

  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [duration, setDuration] = useState("30");
  const [participantIds, setParticipantIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setProjectId("");
    // Defaults to now, rounded to the hour.
    const now = new Date();
    now.setMinutes(0, 0, 0);
    setStartsAt(new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    setDuration("30");
    setParticipantIds([]);
  }, [open]);

  const create = useMutation(async () => {
    const parsedDuration = Number(duration);
    const result = await api.meetings.create({
      title: title.trim(),
      projectId: projectId || null,
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      durationMinutes: Number.isFinite(parsedDuration) ? parsedDuration : null,
      participantIds,
    });
    toast.success("Meeting created");
    onClose();
    navigate(`/meetings/${result.meeting.id}`);
    return result;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New meeting"
      description="Create the record first, then add the transcript."
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
          <label className="label" htmlFor="meeting-title">
            Title
          </label>
          <input
            id="meeting-title"
            className="input"
            placeholder="Weekly delivery sync"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </div>

        <div className="row gap-3" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="meeting-when">
              When
            </label>
            <input
              id="meeting-when"
              className="input"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>
          <div className="field" style={{ width: 110 }}>
            <label className="label" htmlFor="meeting-duration">
              Minutes
            </label>
            <input
              id="meeting-duration"
              className="input"
              type="number"
              min={0}
              step={15}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="meeting-project">
            Project
          </label>
          <select
            id="meeting-project"
            className="select"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Not project-specific</option>
            {(projects.data?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <span className="label">Participants</span>
          <div className="stack gap-2" style={{ maxHeight: 180, overflowY: "auto" }}>
            {(members.data?.members ?? []).map((member) => (
              <label key={member.userId} className="row gap-2 text-sm" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={participantIds.includes(member.userId)}
                  onChange={(event) =>
                    setParticipantIds((prev) =>
                      event.target.checked
                        ? [...prev, member.userId]
                        : prev.filter((id) => id !== member.userId),
                    )
                  }
                />
                {member.name}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
