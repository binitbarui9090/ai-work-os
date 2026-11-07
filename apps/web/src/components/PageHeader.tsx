import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./ui/index.js";
import styles from "../pages/pages.module.css";

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
  badge,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className={styles.breadcrumb} aria-label="Breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="row gap-1">
                {index > 0 && <Icon name="chevron-right" size={11} />}
                {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className={styles.pageTitle}>
          {title}
          {badge}
        </h1>
        {subtitle && <p className={styles.pageSubtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.headerActions}>{actions}</div>}
    </header>
  );
}

export function SectionHeader({
  title,
  action,
}: {
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {action}
    </div>
  );
}
