/**
 * Meeting detail.
 *
 * Processing state is shown as it really is: queued, processing, completed or
 * failed with the reason. The summary section does not render a placeholder
 * when nothing has been extracted — it says what is missing and why.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { MeetingDetail } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, formatDateTime, pluralise, useAsync, useMutation } from "../lib/hooks.js";
import { useChannel, useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { CommentThread } from "../components/CommentThread.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import {
  AvatarGroup,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Modal,
  Notice,
  Spinner,
  Tabs,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";
import meetingStyles from "./meeting.module.css";

export function MeetingPage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const toast = useToast();

  const loaded = useAsync(() => api.meetings.get(meetingId), [meetingId]);
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);
  const projects = useAsync(() => api.projects.list(), [workspace.id]);

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<"summary" | "transcript" | "comments">("summary");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [convertProjectId, setConvertProjectId] = useState("");

  useEffect(() => {
    if (loaded.data) setMeeting(loaded.data.meeting);
  }, [loaded.data]);

  useEffect(() => {
    if (meeting?.projectId) setConvertProjectId(meeting.projectId);
  }, [meeting?.projectId]);

  useChannel(meetingId ? `meeting:${meetingId}` : null);

  useRealtimeEvent("meeting.processed", (event) => {
    if (event.meeting.id === meetingId) loaded.reload();
  });

  // Processing happens in a worker; poll while it is in flight so the page
  // updates even if the realtime event is missed.
  useEffect(() => {
    if (!meeting) return;
    if (meeting.processingStatus !== "queued" && meeting.processingStatus !== "processing") return;
    const timer = window.setInterval(() => loaded.reload(), 3000);
    return () => clearInterval(timer);
  }, [meeting?.processingStatus, loaded]);

  const convert = useMutation(async () => {
    if (!convertProjectId || selectedItems.length === 0) return;
    const result = await api.meetings.convertActionItems(
      meetingId,
      selectedItems,
      convertProjectId,
    );
    if (result.created.length > 0) {
      toast.success(
        `Created ${pluralise(result.created.length, "task")}`,
        result.created.map((c) => c.reference).join(", "),
      );
    }
    if (result.skipped.length > 0) {
      toast.info("Some items were skipped", result.skipped.join("; "));
    }
    setSelectedItems([]);
    loaded.reload();
    return result;
  });

  const remove = useMutation(async () => {
    await api.meetings.remove(meetingId);
    toast.success("Meeting deleted");
    navigate("/meetings");
  });

  if (loaded.loading && !meeting) {
    return (
      <>
        <PageHeader title="Loading meeting" />
        <LoadingRows rows={4} />
      </>
    );
  }

  if (loaded.error || !meeting) {
    return <ErrorState error={loaded.error} onRetry={loaded.reload} />;
  }

  const canEdit = workspace.role !== "guest";
  const processing =
    meeting.processingStatus === "queued" || meeting.processingStatus === "processing";
  const unconverted = meeting.actionItems.filter((item) => !item.taskId);

  return (
    <div className="fade-in">
      <PageHeader
        breadcrumbs={[{ label: "Meetings", to: "/meetings" }, { label: meeting.title }]}
        title={meeting.title}
        subtitle={
          <>
            {meeting.startsAt ? formatDateTime(meeting.startsAt) : "No date set"}
            {meeting.durationMinutes ? ` · ${meeting.durationMinutes} minutes` : ""}
            {meeting.projectId && (
              <>
                {" · "}
                <Link to={`/projects/${meeting.projectId}`}>project</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {meeting.participants.length > 0 && (
              <AvatarGroup users={meeting.participants} size={24} />
            )}
            {canEdit && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setUploadOpen(true)}
                  disabled={processing}
                >
                  <Icon name="sparkle" size={14} />
                  {meeting.hasTranscript ? "Replace transcript" : "Add transcript"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete meeting"
                >
                  <Icon name="trash" size={14} />
                </button>
              </>
            )}
          </>
        }
      />

      {processing && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Notice tone="info" title="Processing the transcript">
            <span className="row gap-2">
              <Spinner />
              This runs in the background. The summary, decisions and action items will appear here
              when it finishes.
            </span>
          </Notice>
        </div>
      )}

      {meeting.processingStatus === "failed" && meeting.processingError && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Notice tone="danger" title="Transcript processing did not complete">
            {meeting.processingError}
          </Notice>
        </div>
      )}

      <div style={{ marginBottom: "var(--space-5)" }}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "summary", label: "Summary" },
            {
              id: "transcript",
              label: "Transcript",
              count: meeting.segments.length || undefined,
            },
            { id: "comments", label: "Comments" },
          ]}
        />
      </div>

      {tab === "summary" && (
        <div className="stack gap-6">
          {!meeting.hasTranscript ? (
            <div className="card">
              <EmptyState
                icon="mic"
                title="No transcript yet"
                body="Paste the transcript and the summary, decisions and action items get extracted. Until then there is nothing to summarise."
                action={
                  canEdit ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setUploadOpen(true)}
                    >
                      Add transcript
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : meeting.summary ? (
            <section>
              <SectionHeader title="Summary" />
              <div className="card card-padded">
                <div className="prose" style={{ whiteSpace: "pre-wrap" }}>
                  {meeting.summary}
                </div>
              </div>
            </section>
          ) : (
            !processing && (
              <Notice tone="neutral" title="No summary was extracted">
                The transcript is stored and searchable, but no summary has been produced yet.
              </Notice>
            )
          )}

          {meeting.decisions.length > 0 && (
            <section>
              <SectionHeader title={`Decisions (${meeting.decisions.length})`} />
              <div className="card">
                {meeting.decisions.map((decision, index) => (
                  <div key={index} className={meetingStyles.listRow}>
                    <Icon
                      name="check"
                      size={14}
                      style={{ color: "var(--success)", flexShrink: 0, marginTop: 2 }}
                    />
                    <span>{decision}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {meeting.risks.length > 0 && (
            <section>
              <SectionHeader title={`Risks raised (${meeting.risks.length})`} />
              <div className="card">
                {meeting.risks.map((risk, index) => (
                  <div key={index} className={meetingStyles.listRow}>
                    <Icon
                      name="alert"
                      size={14}
                      style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }}
                    />
                    <span>{risk}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {meeting.actionItems.length > 0 && (
            <section>
              <SectionHeader
                title={`Action items (${meeting.actionItems.length})`}
                action={
                  unconverted.length > 0 && canEdit ? (
                    <span className="text-xs text-tertiary">
                      Select the ones to turn into tasks
                    </span>
                  ) : undefined
                }
              />

              <div className="card">
                {meeting.actionItems.map((item) => {
                  const converted = Boolean(item.taskId);
                  return (
                    <div key={item.id} className={meetingStyles.actionItem}>
                      {canEdit && !converted ? (
                        <input
                          type="checkbox"
                          className="checkbox"
                          style={{ marginTop: 3 }}
                          checked={selectedItems.includes(item.id)}
                          onChange={(event) =>
                            setSelectedItems((prev) =>
                              event.target.checked
                                ? [...prev, item.id]
                                : prev.filter((id) => id !== item.id),
                            )
                          }
                          aria-label={`Select "${item.text}"`}
                        />
                      ) : (
                        <Icon
                          name={converted ? "check" : "dot"}
                          size={converted ? 14 : 8}
                          style={{
                            color: converted ? "var(--success)" : "var(--text-tertiary)",
                            flexShrink: 0,
                            marginTop: converted ? 2 : 6,
                          }}
                        />
                      )}

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="text-sm">{item.text}</div>
                        <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
                          {item.ownerHint ? `Owner named: ${item.ownerHint}` : "No owner named"}
                          {item.dueHint ? ` · ${item.dueHint}` : ""}
                          {!item.suggestedAssigneeId && item.ownerHint
                            ? " · no matching workspace member"
                            : ""}
                        </div>
                      </div>

                      {converted && item.taskId && (
                        <Link to={`/tasks/${item.taskId}`} className="badge badge-success">
                          Task created
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>

              {selectedItems.length > 0 && canEdit && (
                <div className={meetingStyles.convertBar}>
                  <span className="text-sm">
                    {pluralise(selectedItems.length, "item")} selected
                  </span>
                  <span className="spacer" />
                  <select
                    className="select"
                    style={{ width: 220, height: 30 }}
                    value={convertProjectId}
                    onChange={(event) => setConvertProjectId(event.target.value)}
                    aria-label="Target project"
                  >
                    <option value="">Choose a project…</option>
                    {(projects.data?.projects ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void convert.run()}
                    disabled={convert.pending || !convertProjectId}
                  >
                    {convert.pending && <span className="spinner" />}
                    Create tasks
                  </button>
                </div>
              )}

              {convert.error && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Notice tone="danger">{errorMessage(convert.error)}</Notice>
                </div>
              )}
            </section>
          )}

          {meeting.notes && (
            <section>
              <SectionHeader title="Notes" />
              <div className="card card-padded">
                <div className="prose" style={{ whiteSpace: "pre-wrap" }}>
                  {meeting.notes}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {tab === "transcript" && (
        <div>
          {meeting.segments.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="mic"
                title="No transcript"
                body="Add one to make this meeting searchable."
                compact
              />
            </div>
          ) : (
            <div className={meetingStyles.transcript}>
              {meeting.segments.map((segment) => (
                <div key={segment.id} className={meetingStyles.segment}>
                  <span className={meetingStyles.segmentSpeaker}>
                    {segment.speaker ?? "Unknown"}
                  </span>
                  {segment.startSeconds !== null && (
                    <span className={meetingStyles.segmentTime}>
                      {formatSeconds(segment.startSeconds)}
                    </span>
                  )}
                  <span className={meetingStyles.segmentText}>{segment.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "comments" && (
        <div style={{ maxWidth: "var(--prose-max)" }}>
          <CommentThread
            entityType="meeting"
            entityId={meetingId}
            members={members.data?.members ?? []}
          />
        </div>
      )}

      <UploadTranscriptDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        meetingId={meetingId}
        onUploaded={() => loaded.reload()}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove.run()}
        title="Delete this meeting?"
        body="The transcript, summary and extracted action items are removed. Tasks already created from it are kept."
        confirmLabel="Delete meeting"
        destructive
        pending={remove.pending}
      />
    </div>
  );
}

function UploadTranscriptDialog({
  open,
  onClose,
  meetingId,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  meetingId: string;
  onUploaded: () => void;
}) {
  const toast = useToast();
  const [transcript, setTranscript] = useState("");

  useEffect(() => {
    if (open) setTranscript("");
  }, [open]);

  const upload = useMutation(async () => {
    await api.meetings.uploadTranscript(meetingId, transcript.trim(), "manual-upload");
    toast.info("Transcript queued", "Processing runs in the background.");
    onClose();
    onUploaded();
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Add a transcript"
      description='Lines like "Alice: we decided to ship on Friday" are parsed into speakers. Timestamps in [00:12:34] or (00:12) form are picked up too.'
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void upload.run()}
            disabled={upload.pending || transcript.trim().length < 20}
          >
            {upload.pending && <span className="spinner" />}
            Upload &amp; process
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        {upload.error && <Notice tone="danger">{errorMessage(upload.error)}</Notice>}
        <textarea
          className="textarea"
          style={{ minHeight: 320, fontFamily: "var(--font-mono)", fontSize: 12 }}
          placeholder={"Maya: Let's start with the billing migration.\nDev: The schema is frozen."}
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          autoFocus
        />
        <span className="field-hint">
          {transcript.length.toLocaleString()} characters. The transcript is stored and made
          searchable even if extraction cannot run.
        </span>
      </div>
    </Modal>
  );
}

function formatSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export { styles };
