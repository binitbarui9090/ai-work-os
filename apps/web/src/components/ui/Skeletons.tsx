/**
 * Content-shaped loading states.
 *
 * A column of identical grey bars tells you nothing and guarantees a layout
 * jump when the real content lands. These mirror the shape of what is coming,
 * so the page settles instead of rearranging itself.
 *
 * Used only for a *first* load. A refetch over existing content dims the
 * previous render instead (see `useAsync().refreshing`).
 */
import styles from "./skeletons.module.css";

function Bar({ width, height = 12 }: { width: string; height?: number }) {
  return <span className="skeleton" style={{ width, height, display: "block" }} />;
}

/** Mirrors a task row: toggle, reference, title, then right-aligned metadata. */
export function TaskListSkeleton({ rows = 6 }: { rows?: number }) {
  // Deterministic widths: random ones shimmer differently on every render,
  // which reads as the content changing rather than loading.
  const widths = ["58%", "72%", "44%", "66%", "51%", "77%", "63%", "48%"];

  return (
    <div className="card" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading tasks</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.taskRow}>
          <span className={`skeleton ${styles.circle}`} />
          <Bar width="52px" />
          <span style={{ flex: 1 }}>
            <Bar width={widths[i % widths.length]!} />
          </span>
          <Bar width="44px" />
          <span className={`skeleton ${styles.circle}`} />
        </div>
      ))}
    </div>
  );
}

/** Mirrors the board: columns of cards at varying heights. */
export function BoardSkeleton({ columns = 5 }: { columns?: number }) {
  const cardsPerColumn = [3, 2, 4, 1, 2, 3];

  return (
    <div className={styles.board} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the board</span>
      {Array.from({ length: columns }, (_, column) => (
        <div key={column} className={styles.column}>
          <div className={styles.columnHeader}>
            <Bar width="60px" height={10} />
          </div>
          {Array.from({ length: cardsPerColumn[column % cardsPerColumn.length]! }, (_, card) => (
            <div key={card} className={styles.card}>
              <Bar width="44px" height={9} />
              <Bar width="88%" />
              <Bar width="62%" />
              <div className={styles.cardFooter}>
                <span className={`skeleton ${styles.circleSmall}`} />
                <Bar width="34px" height={9} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Mirrors a stat-tile row, so the dashboard does not reflow on load. */
export function StatGridSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div className={styles.statGrid} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading figures</span>
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className={styles.statTile}>
          <Bar width="64px" height={10} />
          <Bar width="48px" height={24} />
          <Bar width="80%" height={9} />
        </div>
      ))}
    </div>
  );
}

/** Mirrors the project card grid. */
export function CardGridSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className={styles.cardGrid} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading projects</span>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={styles.projectCard}>
          <div className={styles.projectTop}>
            <span className={`skeleton ${styles.swatch}`} />
            <span style={{ flex: 1 }}>
              <Bar width="70%" />
              <span style={{ display: "block", height: 6 }} />
              <Bar width="38%" height={9} />
            </span>
          </div>
          <Bar width="100%" height={5} />
          <Bar width="56%" height={9} />
        </div>
      ))}
    </div>
  );
}

/** Mirrors a prose block: a heading plus ragged lines. */
export function ProseSkeleton({ lines = 5 }: { lines?: number }) {
  const widths = ["92%", "97%", "84%", "95%", "61%", "89%", "73%"];
  return (
    <div className={styles.prose} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <Bar width="42%" height={18} />
      <span style={{ display: "block", height: 10 }} />
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ display: "block", marginBottom: 8 }}>
          <Bar width={widths[i % widths.length]!} />
        </span>
      ))}
    </div>
  );
}

/** Mirrors a chart card: a plot area with axis ticks and a legend. */
export function ChartSkeleton() {
  return (
    <div className={styles.chartCard} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading chart</span>
      <Bar width="120px" height={12} />
      <span style={{ display: "block", height: 4 }} />
      <Bar width="60%" height={9} />
      <div className={styles.plot}>
        <span className={`skeleton ${styles.plotArea}`} />
      </div>
      <div className={styles.legendRow}>
        <Bar width="72px" height={9} />
        <Bar width="64px" height={9} />
      </div>
    </div>
  );
}
