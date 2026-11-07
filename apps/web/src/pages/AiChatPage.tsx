/**
 * Workspace chat.
 *
 * Shows the agent's work honestly: which tools it called, what each returned,
 * what it cited, and — critically — that a mutating call is a *proposal* that
 * has changed nothing. Assistant text streams in over the WebSocket while the
 * request is in flight.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AiAction, AiMessage } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useChannel, useRealtimeEvent } from "../lib/realtime.js";
import { useCurrentUser, useWorkspace } from "../lib/session.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  Avatar,
  EmptyState,
  Icon,
  Notice,
  Spinner,
  useToast,
} from "../components/ui/index.js";
import { PendingActionCard } from "./AiActionsPage.js";
import styles from "./ai.module.css";

const SUGGESTIONS = [
  "What is blocked right now, and who is waiting on whom?",
  "Summarise where the billing migration stands.",
  "Which tasks are overdue and who owns them?",
  "What did we decide in the last meeting?",
  "Is anyone duplicating work across projects?",
];

export function AiChatPage() {
  const me = useCurrentUser();
  const workspace = useWorkspace();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const conversationId = searchParams.get("c");
  const projectId = searchParams.get("projectId");

  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [pendingActions, setPendingActions] = useState<AiAction[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const capabilities = useAsync(() => api.ai.capabilities(), [workspace.id]);
  const conversations = useAsync(() => api.ai.conversations(), [workspace.id, messages.length]);
  const history = useAsync(
    async () => (conversationId ? api.ai.conversation(conversationId) : null),
    [conversationId],
  );

  useEffect(() => {
    if (history.data) {
      setMessages(history.data.messages);
      setPendingActions(history.data.pendingActions);
    } else if (!conversationId) {
      setMessages([]);
      setPendingActions([]);
    }
  }, [history.data, conversationId]);

  useChannel(conversationId ? `ai:${conversationId}` : null);

  useRealtimeEvent("ai.message.delta", (event) => {
    if (event.conversationId !== conversationId) return;
    setStreamingText((previous) => previous + event.delta);
  });

  // Auto-scroll while a response is arriving.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, streamingText]);

  const send = useMutation(async (text: string) => {
    setDraft("");
    setStreamingText("");

    // The user's turn appears immediately; the id is replaced by the response.
    const optimistic: AiMessage = {
      id: `pending-${Date.now()}`,
      conversationId: conversationId ?? "",
      role: "user",
      content: text,
      citations: [],
      toolCalls: [],
      usage: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const response = await api.ai.chat({
        message: text,
        conversationId: conversationId ?? null,
        projectId,
      });

      setStreamingText("");
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimistic.id),
        { ...optimistic, id: `${optimistic.id}-sent`, conversationId: response.conversationId },
        response.message,
      ]);
      setPendingActions((prev) => [...response.pendingActions, ...prev]);

      if (!conversationId) {
        const params = new URLSearchParams(searchParams);
        params.set("c", response.conversationId);
        setSearchParams(params, { replace: true });
      }
      return response;
    } catch (err) {
      setStreamingText("");
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      toast.error("Could not send that", errorMessage(err));
      throw err;
    }
  });

  const capability = capabilities.data?.capabilities;
  const disabled = capability ? !capability.chatEnabled : false;

  const grouped = useMemo(() => messages, [messages]);

  return (
    <div className="fade-in">
      <PageHeader
        title="Ask AI"
        subtitle="It reads your workspace before answering, cites what it used, and asks before changing anything."
        actions={
          <>
            {capability?.llmModel && (
              <span className="badge" title="Configured model">
                {capability.llmModel}
              </span>
            )}
            <Link
              to="/ai"
              className="btn btn-secondary"
              onClick={() => {
                setMessages([]);
                setPendingActions([]);
                setSearchParams(new URLSearchParams(), { replace: true });
              }}
            >
              <Icon name="plus" size={14} />
              New chat
            </Link>
          </>
        }
      />

      {disabled && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Notice tone="warning" title="AI chat is unavailable">
            {capability?.disabledReason}
          </Notice>
        </div>
      )}

      <div className={styles.chatLayout}>
        <aside className={styles.conversationList} aria-label="Conversations">
          {(conversations.data?.conversations ?? []).length === 0 ? (
            <p className="text-xs text-tertiary" style={{ padding: "var(--space-2)" }}>
              Your conversations will appear here.
            </p>
          ) : (
            conversations.data!.conversations.map((conversation) => (
              <Link
                key={conversation.id}
                to={`/ai?c=${conversation.id}`}
                className={`${styles.conversationItem} ${
                  conversation.id === conversationId ? styles.conversationActive : ""
                }`}
              >
                <span className={styles.conversationTitle}>{conversation.title}</span>
                <span className={styles.conversationMeta}>
                  {relativeTime(conversation.updatedAt)}
                </span>
              </Link>
            ))
          )}
        </aside>

        <div className={styles.chatPanel}>
          <div className={styles.messages} ref={scrollRef}>
            {history.loading ? (
              <Spinner label="Loading conversation" />
            ) : grouped.length === 0 ? (
              <EmptyState
                icon="sparkle"
                title="Ask about anything in this workspace"
                body={
                  disabled
                    ? "Configure an AI provider to use this."
                    : "It can only answer from what it retrieves, so expect it to say when it cannot find something."
                }
                action={
                  !disabled ? (
                    <div className={styles.suggestions}>
                      {SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          className={styles.suggestion}
                          onClick={() => {
                            setDraft(suggestion);
                            textareaRef.current?.focus();
                          }}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : undefined
                }
              />
            ) : (
              grouped.map((message) => (
                <MessageView key={message.id} message={message} me={me} />
              ))
            )}

            {send.pending && (
              <div className={styles.message}>
                <span className={`${styles.messageAvatar} ${styles.messageAvatarAi}`}>
                  <Icon name="sparkle" size={14} />
                </span>
                <div className={styles.messageBody}>
                  <div className={styles.messageRole}>AI</div>
                  {streamingText ? (
                    <div className={styles.messageText}>
                      {streamingText}
                      <span aria-hidden>▌</span>
                    </div>
                  ) : (
                    <Spinner label="Reading your workspace" />
                  )}
                </div>
              </div>
            )}

            {pendingActions.length > 0 && (
              <div className="stack gap-3">
                <Notice tone="info" title="Waiting for your approval">
                  These proposals have not been applied. Review each one below.
                </Notice>
                {pendingActions.map((action) => (
                  <PendingActionCard
                    key={action.id}
                    action={action}
                    onDecided={(updated) =>
                      setPendingActions((prev) =>
                        prev.filter((candidate) => candidate.id !== updated.id),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <div className={styles.composer}>
            <div className={styles.composerRow}>
              <textarea
                ref={textareaRef}
                className={styles.composerInput}
                placeholder={
                  disabled ? "AI is unavailable on this deployment" : "Ask about projects, tasks, documents or meetings…"
                }
                value={draft}
                disabled={disabled || send.pending}
                rows={1}
                onChange={(event) => {
                  setDraft(event.target.value);
                  // Grow with the content up to the CSS max-height.
                  event.target.style.height = "auto";
                  event.target.style.height = `${Math.min(180, event.target.scrollHeight)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (draft.trim()) void send.run(draft.trim());
                  }
                }}
                aria-label="Message"
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ height: 42 }}
                onClick={() => draft.trim() && void send.run(draft.trim())}
                disabled={disabled || send.pending || draft.trim().length === 0}
              >
                {send.pending ? <span className="spinner" /> : <Icon name="arrow-right" size={15} />}
                Send
              </button>
            </div>
            <div className={styles.composerHint}>
              <kbd>↵</kbd> send · <kbd>⇧</kbd> <kbd>↵</kbd> new line
              {capability?.requireApproval && " · changes need your approval"}
              {capability && !capability.semanticSearchEnabled &&
                " · semantic search is off, so retrieval uses full-text search"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageView({ message, me }: { message: AiMessage; me: { id: string; name: string; avatarUrl: string | null } }) {
  const [traceOpen, setTraceOpen] = useState(false);
  const isUser = message.role === "user";

  return (
    <article className={styles.message}>
      {isUser ? (
        <Avatar user={me} size={28} />
      ) : (
        <span className={`${styles.messageAvatar} ${styles.messageAvatarAi}`}>
          <Icon name="sparkle" size={14} />
        </span>
      )}

      <div className={styles.messageBody}>
        <div className={styles.messageRole}>{isUser ? me.name : "AI"}</div>

        {message.error ? (
          <div className={styles.messageError}>
            <Icon name="alert" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              <strong>The AI could not answer.</strong> {message.error}
            </span>
          </div>
        ) : (
          <div className={styles.messageText}>{message.content}</div>
        )}

        {message.toolCalls.length > 0 && (
          <div className={styles.toolTrace}>
            <button
              type="button"
              className={styles.toolTraceHeader}
              onClick={() => setTraceOpen((open) => !open)}
              aria-expanded={traceOpen}
            >
              <Icon name={traceOpen ? "chevron-down" : "chevron-right"} size={12} />
              {message.toolCalls.length} tool {message.toolCalls.length === 1 ? "call" : "calls"}
              <span className="spacer" />
              {message.toolCalls.some((call) => call.status === "pending_approval") && (
                <span className="badge badge-accent">needs approval</span>
              )}
              {message.toolCalls.some((call) => call.status === "failed") && (
                <span className="badge badge-danger">had an error</span>
              )}
            </button>
            {traceOpen && (
              <div className={styles.toolTraceBody}>
                {message.toolCalls.map((call) => (
                  <div key={call.id} className={styles.toolCall}>
                    <span className={styles.toolName}>{call.name}</span>
                    <span
                      className={
                        call.status === "succeeded"
                          ? styles.toolStatusOk
                          : call.status === "failed"
                            ? styles.toolStatusFailed
                            : styles.toolStatusPending
                      }
                    >
                      {call.status === "pending_approval" ? "awaiting approval" : call.status}
                    </span>
                    <span className="text-secondary" style={{ flex: 1 }}>
                      {call.resultSummary}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {message.citations.length > 0 && (
          <div className={styles.citations}>
            {message.citations.map((citation) => (
              <Link key={`${citation.entityType}-${citation.entityId}`} to={citation.url} className={styles.citation}>
                <Icon
                  name={
                    { task: "list", document: "doc", meeting: "mic", project: "board" }[
                      citation.entityType
                    ] as "list"
                  }
                  size={11}
                />
                <span className="truncate">{citation.title}</span>
              </Link>
            ))}
          </div>
        )}

        {message.usage && (
          <div className="text-xs text-tertiary" style={{ marginTop: "var(--space-2)" }}>
            {message.usage.inputTokens.toLocaleString()} in ·{" "}
            {message.usage.outputTokens.toLocaleString()} out
          </div>
        )}
      </div>
    </article>
  );
}
