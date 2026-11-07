/**
 * Thin segmented bar — one whole split into a few ordered parts.
 *
 * Chosen over a donut because the reader sees the split beside its figures
 * (the legend and the surrounding stat tiles carry the numbers), so printing
 * values on the bar would add nothing. 8px, fully rounded ends, no text on
 * the bar; a 2px surface gap separates touching fills.
 *
 * The parts are an *ordered* progression (not started → in flight → done), so
 * they take a one-hue ordinal ramp rather than categorical hues — the reader
 * sees the order in the colour. `blocked` is a genuine status, so it uses the
 * reserved status colour and always ships with an icon and a label.
 */
import { useState } from "react";
import { Icon } from "../ui/Icon.js";
import styles from "./charts.module.css";

export interface Segment {
  id: string;
  label: string;
  value: number;
  /** A CSS colour, normally one of the `--chart-stage-*` tokens. */
  color: string;
  /** Renders a warning icon beside the legend entry; for reserved statuses. */
  status?: boolean;
}

export function SegmentedBar({
  segments,
  total,
  dense,
  showLegend = true,
  caption,
}: {
  segments: Segment[];
  /** Defaults to the sum of the segments. Pass it to leave a remainder gap. */
  total?: number;
  dense?: boolean;
  showLegend?: boolean;
  /** Accessible description of what the whole represents. */
  caption: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const sum = total ?? segments.reduce((acc, segment) => acc + segment.value, 0);
  const present = segments.filter((segment) => segment.value > 0);

  if (sum === 0) {
    return (
      <div className={styles.segmentedWrap}>
        <div className={`${styles.segmented} ${dense ? styles.segmentedDense : ""}`} />
        {showLegend && <p className={styles.statMeta}>Nothing to show yet.</p>}
      </div>
    );
  }

  const share = (value: number) => Math.round((value / sum) * 100);

  // The accessible name carries every part's name, amount and share, so the
  // information is never gated behind hover.
  const accessibleName = `${caption}: ${present
    .map((segment) => `${segment.label} ${segment.value} (${share(segment.value)}%)`)
    .join(", ")}`;

  return (
    <div className={styles.segmentedWrap}>
      <div
        className={`${styles.segmented} ${dense ? styles.segmentedDense : ""}`}
        role="img"
        aria-label={accessibleName}
        tabIndex={0}
      >
        {present.map((segment) => (
          <div
            key={segment.id}
            className={`${styles.segment} ${hovered === segment.id ? styles.segmentHovered : ""}`}
            style={{
              // A part at zero draws nothing; the rest are proportional.
              width: `${(segment.value / sum) * 100}%`,
              background: segment.color,
            }}
            title={`${segment.label}: ${segment.value} (${share(segment.value)}%)`}
            onMouseEnter={() => setHovered(segment.id)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>

      {showLegend && (
        <div className={styles.legend}>
          {/* Names in block order; the legend repeats no numbers. */}
          {segments.map((segment) => (
            <span
              key={segment.id}
              className={styles.legendItem}
              onMouseEnter={() => setHovered(segment.id)}
              onMouseLeave={() => setHovered(null)}
            >
              {segment.status ? (
                <span className={styles.legendStatus} style={{ color: segment.color }}>
                  <Icon name="blocked" size={11} />
                </span>
              ) : (
                <span className={styles.legendSwatch} style={{ background: segment.color }} />
              )}
              {segment.label}
              <span className="text-tertiary tabular">{segment.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collapses the seven task statuses into the four groups a reader actually
 * asks about: what is left, what is moving, what is finished, what is stuck.
 *
 * Seven segments would blur into each other and spend the ordinal ramp on
 * distinctions nobody reads at a glance; `canceled` is excluded because it is
 * not outstanding work.
 */
export function taskStatusSegments(counts: Record<string, number>): Segment[] {
  const get = (key: string) => counts[key] ?? 0;
  return [
    {
      id: "not-started",
      label: "Not started",
      value: get("backlog") + get("todo"),
      color: "var(--chart-stage-1)",
    },
    {
      id: "in-flight",
      label: "In flight",
      value: get("in_progress") + get("in_review"),
      color: "var(--chart-stage-2)",
    },
    { id: "done", label: "Done", value: get("done"), color: "var(--chart-stage-3)" },
    {
      id: "blocked",
      label: "Blocked",
      value: get("blocked"),
      color: "var(--chart-blocked)",
      status: true,
    },
  ];
}
