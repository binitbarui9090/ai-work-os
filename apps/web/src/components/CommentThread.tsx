/**
 * Comment thread with mentions and live updates.
 *
 * New comments arrive over the realtime channel for the entity, and typing
 * indicators are sent while composing. Mentions are written as `@"Full Name"`,
 * which the server re-resolves — the picker here is a convenience, not the
 * source of truth.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment, EntityType, PublicUser, WorkspaceMember } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useChannel, useRealtime, useRealtimeEvent } from "../lib/realtime.js";
import { useCurrentUser } from "../lib/session.js";
import { Avatar, EmptyState, Icon, LoadingRows, Notice, useToast } from "./ui/index.js";
import styles from "../pages/pages.module.css";

export function CommentThread({
  entityType,
  entityId,
  members,
}: {
  entityType: EntityType;
  entityId: string;
  members: WorkspaceMember[];
}) {
  const me = useCurrentUser();
  const toast = useToast();
  const [comments, setComments] = useState<Comment[]>([]);
  const [typing, setTyping] = useState<PublicUser[]>([]);

  const loaded = useAsync(() => api.comments.list(entityType, entityId), [entityType, entityId]);

  useEffect(() => {
    if (loaded.data) setComments(loaded.data.comments);
  }, [loaded.data]);

  useChannel(`${entityType}:${entityId}`);

  useRealtimeEvent("comment.created", (event) => {
    if (event.comment.entityId !== entityId) return;
    setComments((prev) => {
      const existing = prev.findIndex((c) => c.id === event.comment.id);
      if (existing >= 0) {
        // An edit arrives as the same event type.
        const next = [...prev];
        next[existing] = event.comment;
        return next;
      }
      return [...prev, event.comment];
    });
  });

  useRealtimeEvent("comment.deleted", (event) => {
    if (event.entityId !== entityId) return;
    setComments((prev) => prev.filter((c) => c.id !== event.commentId));
  });

  useRealtimeEvent("typing", (event) => {
    if (event.entityId !== entityId || event.user.id === me.id) return;
    setTyping((prev) => (prev.some((u) => u.id === event.user.id) ? prev : [...prev, event.user]));
    // The indicator is self-clearing: there is no "stopped typing" event.
    window.setTimeout(
      () => setTyping((prev) => prev.filter((u) => u.id !== event.user.id)),
      3500,
    );
  });

  const remove = useMutation(async (commentId: string) => {
    await api.comments.remove(commentId);
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  });

  if (loaded.loading) return <LoadingRows rows={2} />;

  return (
    <div className={styles.comments}>
      {remove.error && <Notice tone="danger">{errorMessage(remove.error)}</Notice>}

      {comments.length === 0 ? (
        <EmptyState
          icon="message"
          title="No comments yet"
          body="Use @ to mention a teammate — they will get a notification."
          compact
        />
      ) : (
        comments.map((comment) => (
          <article key={comment.id} className={styles.comment}>
            <Avatar user={comment.author} size={28} />
            <div className={styles.commentBody}>
              <div className={styles.commentHeader}>
                <span className={styles.commentAuthor}>
                  {comment.author?.name ?? "Unknown"}
                </span>
                {comment.authorIsAi && (
                  <span className={styles.aiChip}>
                    <Icon name="sparkle" size={9} />
                    AI
                  </span>
                )}
                <span className={styles.commentTime}>
                  {relativeTime(comment.createdAt)}
                  {comment.editedAt && " · edited"}
                </span>
              </div>
              <div className={styles.commentText}>
                <CommentBody body={comment.body} />
              </div>
              {comment.author?.id === me.id && (
                <div className={styles.commentActions}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void remove.run(comment.id)}
                    disabled={remove.pending}
                  >
                    <Icon name="trash" size={12} />
                    Delete
                  </button>
                </div>
              )}
            </div>
          </article>
        ))
      )}

      <div className={styles.typingIndicator} aria-live="polite">
        {typing.length === 1
          ? `${typing[0]!.name} is typing…`
          : typing.length > 1
            ? `${typing.length} people are typing…`
            : ""}
      </div>

      <Composer
        entityType={entityType}
        entityId={entityId}
        members={members}
        onCreated={(comment) => {
          // Appended locally as well: the sender's own socket is skipped for
          // typing events but not for comments, so guard against duplicates.
          setComments((prev) =>
            prev.some((c) => c.id === comment.id) ? prev : [...prev, comment],
          );
        }}
        onError={(message) => toast.error("Comment not posted", message)}
      />
    </div>
  );
}

/** Renders `@"Name"` and `@email` mentions as highlighted spans. */
function CommentBody({ body }: { body: string }) {
  const parts = useMemo(() => {
    const result: Array<{ text: string; mention: boolean }> = [];
    const pattern = /@"([^"]{1,80})"|@([\w.+-]+@[\w.-]+\.\w{2,})|@([\w][\w.-]{1,40})/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(body)) !== null) {
      if (match.index > lastIndex) {
        result.push({ text: body.slice(lastIndex, match.index), mention: false });
      }
      result.push({ text: `@${match[1] ?? match[2] ?? match[3]}`, mention: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < body.length) result.push({ text: body.slice(lastIndex), mention: false });
    return result;
  }, [body]);

  return (
    <>
      {parts.map((part, index) =>
        part.mention ? (
          <span key={index} className={styles.commentMention}>
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Composer({
  entityType,
  entityId,
  members,
  onCreated,
  onError,
}: {
  entityType: EntityType;
  entityId: string;
  members: WorkspaceMember[];
  onCreated: (comment: Comment) => void;
  onError: (message: string) => void;
}) {
  const me = useCurrentUser();
  const [body, setBody] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingSent = useRef(0);
  const { reportTyping } = useRealtime();

  const submit = useMutation(async () => {
    const text = body.trim();
    if (!text) return;
    const result = await api.comments.create({ entityType, entityId, body: text });
    setBody("");
    setMentionQuery(null);
    onCreated(result.comment);
    return result;
  });

  useEffect(() => {
    if (submit.error) onError(errorMessage(submit.error));
  }, [submit.error, onError]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.toLowerCase();
    return members
      .filter((member) => member.userId !== me.id)
      .filter(
        (member) =>
          needle === "" ||
          member.name.toLowerCase().includes(needle) ||
          member.email.toLowerCase().includes(needle),
      )
      .slice(0, 5);
  }, [mentionQuery, members, me.id]);

  const insertMention = (member: WorkspaceMember) => {
    // Replace the partial `@token` the user was typing.
    const replaced = body.replace(/@[\w.@+-]*$/, `@"${member.name}" `);
    setBody(replaced);
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const onChange = (value: string) => {
    setBody(value);

    const trailing = /@([\w.@+-]*)$/.exec(value);
    setMentionQuery(trailing ? (trailing[1] ?? "") : null);

    // Throttled so a fast typist does not flood the socket.
    const now = Date.now();
    if (now - lastTypingSent.current > 2000) {
      lastTypingSent.current = now;
      reportTyping(entityType, entityId);
    }
  };

  return (
    <div className={styles.commentComposer}>
      <Avatar user={me} size={28} />
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <textarea
          ref={textareaRef}
          className="textarea"
          style={{ minHeight: 64 }}
          placeholder="Write a comment… use @ to mention someone"
          value={body}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // ⌘/Ctrl + Enter submits; plain Enter adds a newline.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit.run();
            }
            if (event.key === "Escape") setMentionQuery(null);
          }}
        />

        {candidates.length > 0 && (
          <div className="menu" style={{ position: "absolute", left: 0, right: 0, zIndex: 40 }}>
            {candidates.map((member) => (
              <button
                key={member.userId}
                type="button"
                className="menu-item"
                onClick={() => insertMention(member)}
              >
                <Avatar
                  user={{ id: member.userId, name: member.name, avatarUrl: member.avatarUrl }}
                  size={20}
                />
                <span className="truncate" style={{ flex: 1 }}>
                  {member.name}
                </span>
                <span className="text-xs text-tertiary truncate">{member.email}</span>
              </button>
            ))}
          </div>
        )}

        <div
          className="row gap-3"
          style={{ marginTop: "var(--space-2)", justifyContent: "flex-end" }}
        >
          <span className="text-xs text-tertiary">
            <kbd>⌘</kbd> <kbd>↵</kbd> to send
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void submit.run()}
            disabled={submit.pending || body.trim().length === 0}
          >
            {submit.pending && <span className="spinner" />}
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
