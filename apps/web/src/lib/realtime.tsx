/**
 * Realtime connection.
 *
 * One WebSocket per workspace, shared by the whole app through context.
 * Components subscribe to event types rather than touching the socket, so a
 * reconnect or a workspace switch does not require them to re-wire anything.
 *
 * Reconnection backs off exponentially and the connection state is exposed, so
 * the UI can say "reconnecting" instead of silently going stale.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ClientEvent, EntityType, ServerEvent } from "@workos/shared";
import { useSession } from "./session.js";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

type Listener = (event: ServerEvent) => void;

interface RealtimeContextValue {
  state: ConnectionState;
  /** Subscribes to every server event. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
  /** Joins a channel so the server forwards that entity's events. */
  joinChannel(channel: string): void;
  leaveChannel(channel: string): void;
  reportPresence(location: string | null): void;
  reportTyping(entityType: EntityType, entityId: string): void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const MAX_BACKOFF_MS = 20_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status, workspace } = useSession();
  const [state, setState] = useState<ConnectionState>("closed");

  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<Listener>());
  const channelsRef = useRef(new Set<string>());
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const closedByUs = useRef(false);

  const send = useCallback((message: ClientEvent) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const connect = useCallback(() => {
    if (status !== "authenticated" || !workspace) return;

    closedByUs.current = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?workspaceId=${encodeURIComponent(workspace.id)}`;

    setState(attemptRef.current === 0 ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setState("open");
      // Re-join whatever the UI was watching before the drop.
      if (channelsRef.current.size > 0) {
        send({ type: "subscribe", channels: [...channelsRef.current] });
      }
      heartbeatTimer.current = window.setInterval(() => send({ type: "ping" }), 25_000);
    };

    socket.onmessage = (raw) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(raw.data)) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === "pong") return;
      for (const listener of listenersRef.current) {
        try {
          listener(event);
        } catch {
          // One bad listener must not stop the others.
        }
      }
    };

    socket.onclose = () => {
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
      socketRef.current = null;
      if (closedByUs.current) {
        setState("closed");
        return;
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows; reconnection is handled there.
    };

    function scheduleReconnect() {
      attemptRef.current += 1;
      setState("reconnecting");
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attemptRef.current - 1));
      // Jitter avoids a thundering herd when a server restarts.
      const jittered = delay * (0.7 + Math.random() * 0.6);
      reconnectTimer.current = window.setTimeout(connect, jittered);
    }
  }, [status, workspace, send]);

  useEffect(() => {
    connect();
    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      socketRef.current?.close();
      socketRef.current = null;
      attemptRef.current = 0;
    };
  }, [connect]);

  // A tab that comes back from the background may have a dead socket.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (socketRef.current?.readyState === WebSocket.OPEN) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      attemptRef.current = 0;
      connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [connect]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      state,
      subscribe(listener) {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      joinChannel(channel) {
        if (channelsRef.current.has(channel)) return;
        channelsRef.current.add(channel);
        send({ type: "subscribe", channels: [channel] });
      },
      leaveChannel(channel) {
        if (!channelsRef.current.delete(channel)) return;
        send({ type: "unsubscribe", channels: [channel] });
      },
      reportPresence(location) {
        send({ type: "presence", location });
      },
      reportTyping(entityType, entityId) {
        send({ type: "typing", entityType, entityId });
      },
    }),
    [state, send],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error("useRealtime must be used inside a RealtimeProvider");
  return context;
}

/**
 * Runs `handler` for matching server events.
 *
 * The handler is kept in a ref so callers can pass an inline closure without
 * re-subscribing on every render.
 */
export function useRealtimeEvent<T extends ServerEvent["type"]>(
  types: T | T[],
  handler: (event: Extract<ServerEvent, { type: T }>) => void,
): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const typeList = Array.isArray(types) ? types : [types];
  const key = typeList.join(",");

  useEffect(() => {
    const wanted = new Set(key.split(","));
    return subscribe((event) => {
      if (wanted.has(event.type)) {
        handlerRef.current(event as Extract<ServerEvent, { type: T }>);
      }
    });
  }, [subscribe, key]);
}

/** Joins a channel for as long as the component is mounted. */
export function useChannel(channel: string | null): void {
  const { joinChannel, leaveChannel } = useRealtime();
  useEffect(() => {
    if (!channel) return;
    joinChannel(channel);
    return () => leaveChannel(channel);
  }, [channel, joinChannel, leaveChannel]);
}

/** Reports where the user is, so others can see it in the presence list. */
export function usePresenceLocation(location: string | null): void {
  const { reportPresence, state } = useRealtime();
  useEffect(() => {
    if (state !== "open") return;
    reportPresence(location);
  }, [location, reportPresence, state]);
}
