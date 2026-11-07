/**
 * Throughput over the reporting window — tasks created vs completed per day.
 *
 * Two series of the same unit on one shared axis (never a second y-scale).
 * A line chart rather than grouped columns because a 30-day window would
 * crowd 60 bars; both series are equally the subject, so they take two
 * validated categorical slots with a legend always present.
 *
 * Hand-written inline SVG: two series over ≤90 points does not justify a
 * charting library, and this way the marks follow the spec exactly — 2px
 * lines, ≥8px markers with a 2px surface ring, hairline solid gridlines,
 * selective end labels, and a crosshair tooltip with a table-view twin.
 */
import { useMemo, useRef, useState } from "react";
import type { ThroughputPoint } from "@workos/shared";
import { Icon } from "../ui/Icon.js";
import styles from "./charts.module.css";

const WIDTH = 760;
const HEIGHT = 200;
/** Bottom padding reserves the x-axis band so labels are never cropped. */
const PAD = { top: 16, right: 34, bottom: 26, left: 34 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

interface SeriesSpec {
  key: "completed" | "created";
  label: string;
  color: string;
}

const SERIES: SeriesSpec[] = [
  { key: "completed", label: "Completed", color: "var(--chart-series-1)" },
  { key: "created", label: "Created", color: "var(--chart-series-2)" },
];

export function ThroughputChart({
  points,
  stale,
}: {
  points: ThroughputPoint[];
  /** True while refetching: holds the previous render instead of flashing. */
  stale?: boolean;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [active, setActive] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const geometry = useMemo(() => {
    if (points.length === 0) return null;

    const peak = Math.max(1, ...points.map((p) => Math.max(p.created, p.completed)));
    // Round the top to a clean number so the ticks are readable.
    const step = peak <= 4 ? 1 : peak <= 10 ? 2 : peak <= 25 ? 5 : Math.ceil(peak / 5 / 10) * 10;
    const max = Math.ceil(peak / step) * step;

    const x = (index: number) =>
      PAD.left + (points.length === 1 ? PLOT_W / 2 : (index / (points.length - 1)) * PLOT_W);
    const y = (value: number) => PAD.top + PLOT_H - (value / max) * PLOT_H;

    const ticks: number[] = [];
    for (let value = 0; value <= max; value += step) ticks.push(value);

    const path = (key: SeriesSpec["key"]) =>
      points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p[key])}`).join(" ");

    const area = (key: SeriesSpec["key"]) =>
      `${path(key)} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;

    return { max, ticks, x, y, path, area };
  }, [points]);

  const totals = useMemo(
    () => ({
      created: points.reduce((sum, p) => sum + p.created, 0),
      completed: points.reduce((sum, p) => sum + p.completed, 0),
    }),
    [points],
  );

  if (points.length === 0) {
    return (
      <section className={styles.card}>
        <Header view={view} onView={setView} />
        <div className={styles.empty}>No activity in this period.</div>
      </section>
    );
  }

  const g = geometry!;
  // Label only the endpoints: a number on every point goes unread.
  const lastIndex = points.length - 1;

  return (
    <section className={styles.card}>
      <Header view={view} onView={setView} />

      <div className={`${styles.body} ${stale ? styles.stale : ""}`}>
        {view === "chart" ? (
          <>
            <div className={styles.plotWrap} ref={plotRef}>
              <svg
                className={styles.plot}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={
                  `Tasks created and completed per day. ` +
                  `${totals.completed} completed and ${totals.created} created over ` +
                  `${points.length} days. Full figures are in the table view.`
                }
                onMouseLeave={() => setActive(null)}
              >
                {/* Gridlines: hairline, solid, one step off the surface. */}
                {g.ticks.map((tick) => (
                  <g key={tick}>
                    <line
                      className={styles.gridLine}
                      x1={PAD.left}
                      x2={PAD.left + PLOT_W}
                      y1={g.y(tick)}
                      y2={g.y(tick)}
                    />
                    <text
                      className={styles.axisLabel}
                      x={PAD.left - 6}
                      y={g.y(tick)}
                      textAnchor="end"
                      dominantBaseline="middle"
                    >
                      {tick}
                    </text>
                  </g>
                ))}

                <line
                  className={styles.axisLine}
                  x1={PAD.left}
                  x2={PAD.left + PLOT_W}
                  y1={g.y(0)}
                  y2={g.y(0)}
                />

                {/* Date labels: first, last, and the middle if there is room. */}
                {[0, Math.floor(lastIndex / 2), lastIndex]
                  .filter((index, position, all) => all.indexOf(index) === position)
                  .map((index) => (
                    <text
                      key={index}
                      className={styles.axisLabel}
                      x={g.x(index)}
                      y={HEIGHT - 8}
                      textAnchor={index === 0 ? "start" : index === lastIndex ? "end" : "middle"}
                    >
                      {shortDate(points[index]!.date)}
                    </text>
                  ))}

                {SERIES.map((series) => (
                  <g key={series.key}>
                    <path
                      className={styles.seriesArea}
                      d={g.area(series.key)}
                      fill={series.color}
                    />
                    <path className={styles.series} d={g.path(series.key)} stroke={series.color} />
                  </g>
                ))}

                {/* Crosshair for the hovered day. */}
                {active !== null && (
                  <line
                    className={styles.crosshair}
                    x1={g.x(active)}
                    x2={g.x(active)}
                    y1={PAD.top}
                    y2={PAD.top + PLOT_H}
                  />
                )}

                {SERIES.map((series) => {
                  const value = points[lastIndex]![series.key];
                  return (
                    <g key={`${series.key}-end`}>
                      {active !== null && (
                        <circle
                          className={styles.marker}
                          cx={g.x(active)}
                          cy={g.y(points[active]![series.key])}
                          r={4.5}
                          fill={series.color}
                        />
                      )}
                      {/* The endpoint always carries a marker and its value. */}
                      <circle
                        className={styles.marker}
                        cx={g.x(lastIndex)}
                        cy={g.y(value)}
                        r={4}
                        fill={series.color}
                      />
                      <text
                        className={styles.endLabel}
                        x={g.x(lastIndex) + 8}
                        y={g.y(value)}
                        dominantBaseline="middle"
                      >
                        {value}
                      </text>
                    </g>
                  );
                })}

                {/* Hit bands: the full column height, so hover is forgiving. */}
                {points.map((point, index) => {
                  const band = PLOT_W / Math.max(1, points.length - 1);
                  return (
                    <rect
                      key={point.date}
                      className={styles.hitBand}
                      x={g.x(index) - band / 2}
                      y={PAD.top}
                      width={band}
                      height={PLOT_H}
                      onMouseEnter={() => setActive(index)}
                    />
                  );
                })}
              </svg>

              {active !== null && (
                <div
                  className={styles.tooltip}
                  style={{
                    left: `${(g.x(active) / WIDTH) * 100}%`,
                    top: `${(PAD.top / HEIGHT) * 100}%`,
                  }}
                >
                  <div className={styles.tooltipTitle}>{longDate(points[active]!.date)}</div>
                  {SERIES.map((series) => (
                    <div key={series.key} className={styles.tooltipRow}>
                      <span className={styles.legendLine} style={{ background: series.color }} />
                      {series.label}
                      <span className={styles.tooltipValue}>{points[active]![series.key]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* A legend is always present for two or more series. */}
            <div className={styles.legend}>
              {SERIES.map((series) => (
                <span key={series.key} className={styles.legendItem}>
                  <span className={styles.legendLine} style={{ background: series.color }} />
                  {series.label}
                  <span className="text-tertiary tabular">{totals[series.key]}</span>
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption>Tasks created and completed per day</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Created</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Net</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.date}>
                    <td>{longDate(point.date)}</td>
                    <td>{point.created}</td>
                    <td>{point.completed}</td>
                    <td>{point.completed - point.created}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td>{totals.created}</td>
                  <td>{totals.completed}</td>
                  <td>{totals.completed - totals.created}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Header({
  view,
  onView,
}: {
  view: "chart" | "table";
  onView: (view: "chart" | "table") => void;
}) {
  return (
    <div className={styles.header}>
      <div>
        <h3 className={styles.title}>Throughput</h3>
        <p className={styles.subtitle}>
          Tasks completed against tasks created. Completion below creation means scope is growing.
        </p>
      </div>
      <div className={styles.toggle}>
        <button
          type="button"
          className={`${styles.toggleButton} ${view === "chart" ? styles.toggleButtonActive : ""}`}
          onClick={() => onView("chart")}
          aria-label="Show as a chart"
          aria-pressed={view === "chart"}
        >
          <Icon name="activity" size={13} />
        </button>
        <button
          type="button"
          className={`${styles.toggleButton} ${view === "table" ? styles.toggleButtonActive : ""}`}
          onClick={() => onView("table")}
          aria-label="Show as a table"
          aria-pressed={view === "table"}
        >
          <Icon name="list" size={13} />
        </button>
      </div>
    </div>
  );
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
