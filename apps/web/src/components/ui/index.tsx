/**
 * UI primitives.
 *
 * Everything here is presentational and stateless apart from the toast store.
 * Loading, empty and error states are first-class components rather than
 * ad-hoc markup, so every screen handles them the same way.
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
import { createPortal } from "react-dom";
import type { PublicUser, RiskLevel, TaskPriority, TaskStatus } from "@workos/shared";
import { avatarHue, errorMessage, initials } from "../../lib/hooks.js";
import { Icon, type IconName } from "./Icon.js";
import styles from "./ui.module.css";

export { Icon };
export type { IconName };
export {
  BoardSkeleton,
  CardGridSkeleton,
  ChartSkeleton,
  ProseSkeleton,
  StatGridSkeleton,
  TaskListSkeleton,
} from "./Skeletons.js";

// ── Avatar ──────────────────────────────────────────────────────────────────

export function Avatar({
  user,
  size = 24,
  online,
}: {
  user: Pick<PublicUser, "id" | "name" | "avatarUrl"> | null;
  size?: number;
  online?: boolean;
}) {
  const content = (
    <span
      className={styles.avatar}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ["--avatar-hue" as any]: user ? avatarHue(user.id) : 210,
      }}
      title={user?.name ?? "Unassigned"}
      aria-label={user?.name ?? "Unassigned"}
    >
      {user?.avatarUrl ? (
        <img className={styles.avatarImage} src={user.avatarUrl} alt="" />
      ) : user ? (
        initials(user.name)
      ) : (
        <Icon name="user" size={Math.round(size * 0.55)} />
      )}
    </span>
  );

  if (!online) return content;
  return (
    <span className={styles.presenceWrapper}>
      {content}
      <span className={styles.presenceDot} title="Online" />
    </span>
  );
}

export function AvatarGroup({
  users,
  size = 24,
  max = 4,
}: {
  users: Array<Pick<PublicUser, "id" | "name" | "avatarUrl">>;
  size?: number;
  max?: number;
}) {
  const shown = users.slice(0, max);
  const remaining = users.length - shown.length;
  return (
    <span className={styles.avatarGroup}>
      {shown.map((user) => (
        <Avatar key={user.id} user={user} size={size} />
      ))}
      {remaining > 0 && <span className={styles.avatarMore}>+{remaining}</span>}
    </span>
  );
}

// ── Status, priority and risk badges ────────────────────────────────────────

const STATUS_STYLE: Record<TaskStatus, { label: string; className: string }> = {
  backlog: { label: "Backlog", className: "badge" },
  todo: { label: "Todo", className: "badge" },
  in_progress: { label: "In progress", className: "badge badge-info" },
  in_review: { label: "In review", className: "badge badge-accent" },
  blocked: { label: "Blocked", className: "badge badge-danger" },
  done: { label: "Done", className: "badge badge-success" },
  canceled: { label: "Canceled", className: "badge" },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const style = STATUS_STYLE[status];
  return <span className={style.className}>{style.label}</span>;
}

const PRIORITY_STYLE: Record<TaskPriority, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "var(--red-500)" },
  high: { label: "High", color: "var(--amber-500)" },
  medium: { label: "Medium", color: "var(--blue-500)" },
  low: { label: "Low", color: "var(--n-400)" },
  none: { label: "No priority", color: "var(--n-300)" },
};

/** Priority as bars, which reads faster than a coloured word in a dense list. */
export function PriorityIndicator({
  priority,
  showLabel,
}: {
  priority: TaskPriority;
  showLabel?: boolean;
}) {
  const style = PRIORITY_STYLE[priority];
  const filled = { urgent: 3, high: 3, medium: 2, low: 1, none: 0 }[priority];

  return (
    <span
      className="row gap-2"
      title={style.label}
      aria-label={`Priority: ${style.label}`}
      style={{ color: style.color }}
    >
      <span className="row" style={{ gap: 2, alignItems: "flex-end", height: 11 }} aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 3,
              height: 4 + i * 3.5,
              borderRadius: 1,
              background: i < filled ? style.color : "var(--border)",
            }}
          />
        ))}
      </span>
      {showLabel && <span className="text-xs text-secondary">{style.label}</span>}
    </span>
  );
}

const RISK_CLASS: Record<RiskLevel, string> = {
  critical: "badge badge-danger",
  high: "badge badge-danger",
  medium: "badge badge-warning",
  low: "badge badge-success",
};

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={RISK_CLASS[level]}>
      {level.charAt(0).toUpperCase() + level.slice(1)} risk
    </span>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

export function EmptyState({
  icon = "layers",
  title,
  body,
  action,
  compact,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`${styles.state} ${compact ? styles.stateCompact : ""}`}>
      <span className={styles.stateIcon}>
        <Icon name={icon} size={20} />
      </span>
      <div className={styles.stateTitle}>{title}</div>
      {body && <div className={styles.stateBody}>{body}</div>}
      {action && <div className={styles.stateActions}>{action}</div>}
    </div>
  );
}

/**
 * Error state.
 *
 * Shows the server's own message rather than a generic apology, because the
 * API is written to return actionable messages (including "not configured",
 * which tells the operator exactly what to set).
 */
export function ErrorState({
  error,
  onRetry,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const message = errorMessage(error);
  return (
    <div className={`${styles.state} ${compact ? styles.stateCompact : ""}`}>
      <span className={`${styles.stateIcon} ${styles.stateIconDanger}`}>
        <Icon name="alert" size={20} />
      </span>
      <div className={styles.stateTitle}>Could not load this</div>
      <div className={styles.stateBody}>{message}</div>
      {onRetry && (
        <div className={styles.stateActions}>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row gap-2 text-secondary text-sm">
      <span className="spinner" />
      {label && <span>{label}</span>}
      <span className="sr-only">Loading</span>
    </span>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className={styles.skeletonList} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`skeleton ${styles.skeletonRow}`} />
      ))}
    </div>
  );
}

export function CenteredSpinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className={styles.state}>
      <Spinner label={label} />
    </div>
  );
}

// ── Notice ──────────────────────────────────────────────────────────────────

export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "neutral";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const toneClass = {
    info: styles.noticeInfo,
    warning: styles.noticeWarning,
    danger: styles.noticeDanger,
    neutral: "",
  }[tone];
  const icon: IconName = tone === "danger" ? "alert" : tone === "warning" ? "alert" : "sparkle";

  return (
    <div className={`${styles.notice} ${toneClass}`} role={tone === "danger" ? "alert" : undefined}>
      <span className={styles.noticeIcon}>
        <Icon name={icon} size={15} />
      </span>
      <div className={styles.noticeContent}>
        {title && <div className={styles.noticeTitle}>{title}</div>}
        {children && <div className={styles.noticeBody}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the dialog so the keyboard works.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    const focusable = panelRef.current?.querySelector<HTMLElement>(
      "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])",
    );
    focusable?.focus();

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`${styles.modal} ${wide ? styles.modalWide : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle}>{title}</h2>
            {description && <p className={styles.modalDescription}>{description}</p>}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
        {footer && <div className={styles.modalFooter}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  destructive,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${destructive ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending && <span className="spinner" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-secondary" style={{ lineHeight: "var(--leading-snug)" }}>
        {body}
      </div>
    </Modal>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className={styles.tabs} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          className={`${styles.tab} ${tab.id === value ? styles.tabActive : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className={styles.tabCount}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ id: T; label: string; icon?: IconName }>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          className={`${styles.segment} ${option.id === value ? styles.segmentActive : ""}`}
          onClick={() => onChange(option.id)}
        >
          {option.icon && <Icon name={option.icon} size={13} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── Progress ────────────────────────────────────────────────────────────────

export function ProgressBar({ percent, color }: { percent: number; color?: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      className={styles.progressTrack}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={styles.progressFill}
        style={{ width: `${clamped}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  );
}

// ── Tooltip ─────────────────────────────────────────────────────────────────

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  return (
    <span
      className={styles.tooltipWrapper}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && <span className={styles.tooltip} role="tooltip">{label}</span>}
    </span>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  detail?: string;
  leaving?: boolean;
}

interface ToastContextValue {
  show(toast: Omit<Toast, "id">): void;
  success(title: string, detail?: string): void;
  error(title: string, detail?: string): void;
  info(title: string, detail?: string): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    // Mark leaving first so the exit animation can run.
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 150);
  }, []);

  const show = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      // Errors linger: they usually need reading.
      window.setTimeout(() => dismiss(id), toast.tone === "error" ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (title, detail) => show({ tone: "success", title, detail }),
      error: (title, detail) => show({ tone: "error", title, detail }),
      info: (title, detail) => show({ tone: "info", title, detail }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className={styles.toastRegion} role="region" aria-live="polite" aria-label="Notifications">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`${styles.toast} ${
                { success: styles.toastSuccess, error: styles.toastError, info: styles.toastInfo }[
                  toast.tone
                ]
              } ${toast.leaving ? styles.toastLeaving : ""}`}
            >
              <span className={styles.toastIcon}>
                <Icon
                  name={toast.tone === "success" ? "check" : toast.tone === "error" ? "alert" : "sparkle"}
                  size={15}
                />
              </span>
              <div className={styles.toastBody}>
                <div className={styles.toastTitle}>{toast.title}</div>
                {toast.detail && <div className={styles.toastDetail}>{toast.detail}</div>}
              </div>
              <button
                type="button"
                className={styles.toastClose}
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside a ToastProvider");
  return context;
}
