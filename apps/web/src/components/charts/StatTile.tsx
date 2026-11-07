/**
 * Stat tile — the right form for a single headline number.
 *
 * Contract: label (sentence case) · value (semibold, proportional figures) ·
 * optional delta (signed, against a named period, coloured by direction ×
 * whether up is good) · optional sparkline (context series muted, nothing
 * highlighted). A one-bar bar chart would say less and take more room.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "../ui/Icon.js";
import styles from "./charts.module.css";

export interface StatTileProps {
  label: string;
  value: number | string;
  icon?: IconName;
  /** Shown under the value. Keep it to a short clause. */
  meta?: ReactNode;
  delta?: {
    value: number;
    /** What the delta is measured against, e.g. "vs last week". */
    period: string;
    /** False where a rise is bad — overdue counts, for instance. */
    upIsGood?: boolean;
  };
  /** Values oldest → newest. Rendered as a muted sparkline. */
  trend?: number[];
  to?: string;
  /** Paints the value in the danger colour — for counts that demand action. */
  alert?: boolean;
}

export function StatTile({
  label,
  value,
  icon,
  meta,
  delta,
  trend,
  to,
  alert,
}: StatTileProps) {
  const body = (
    <>
      <div className={styles.statLabel}>
        {icon && <Icon name={icon} size={13} />}
        {label}
      </div>

      <div className={styles.statValueRow}>
        <span
          className={styles.statValue}
          style={alert ? { color: "var(--danger)" } : undefined}
        >
          {typeof value === "number" ? compact(value) : value}
        </span>
        {delta && <Delta {...delta} />}
      </div>

      {trend && trend.length > 1 && <Sparkline values={trend} label={label} />}
      {meta && <div className={styles.statMeta}>{meta}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={styles.statTile} style={{ color: "inherit" }}>
        {body}
      </Link>
    );
  }
  return <div className={styles.statTile}>{body}</div>;
}

function Delta({
  value,
  period,
  upIsGood = true,
}: NonNullable<StatTileProps["delta"]>) {
  if (value === 0) {
    return (
      <span className={`${styles.statDelta} ${styles.statDeltaNeutral}`}>
        no change {period}
      </span>
    );
  }
  const up = value > 0;
  // Colour is direction × whether up is good, not direction alone.
  const good = up === upIsGood;
  return (
    <span
      className={`${styles.statDelta} ${good ? styles.statDeltaGood : styles.statDeltaBad}`}
      title={`${up ? "Up" : "Down"} ${Math.abs(value)} ${period}`}
    >
      <Icon name={up ? "chevron-up" : "chevron-down"} size={11} />
      {Math.abs(value)}
      <span className={styles.statDeltaNeutral} style={{ fontWeight: 400 }}>
        {period}
      </span>
    </span>
  );
}

/**
 * Sparkline: context only, so it carries no axis, no labels and no markers.
 * The value above it is the number being read.
 */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const width = 100;
  const height = 24;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  const x = (index: number) => (index / (values.length - 1)) * width;
  const y = (value: number) => height - ((value - min) / span) * (height - 3) - 1.5;

  const path = values.map((value, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(value)}`).join(" ");

  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} trend: ${values.join(", ")}`}
    >
      <path d={path} fill="none" stroke="var(--chart-muted)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      {/* The current period in the accent, the history muted. */}
      <circle
        cx={x(values.length - 1)}
        cy={y(values[values.length - 1]!)}
        r={2.5}
        fill="var(--accent)"
      />
    </svg>
  );
}

/** 1,284 / 12.9K / 4.2M — auto-compact, as the stat-tile contract requires. */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: "var(--space-3)",
      }}
    >
      {children}
    </div>
  );
}
