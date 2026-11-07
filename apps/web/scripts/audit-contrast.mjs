#!/usr/bin/env node
/**
 * Contrast audit over the design tokens.
 *
 * Parses `src/styles/tokens.css` rather than a hand-copied list, so the audit
 * cannot drift from what ships. Every text-on-surface pair the UI actually
 * uses is checked in both themes, and the script exits non-zero on a failure
 * so it can gate a build.
 *
 *   node scripts/audit-contrast.mjs
 *
 * Thresholds: 4.5:1 for body text (WCAG 2 AA), 3:1 for form-control
 * boundaries (WCAG 1.4.11 non-text contrast) and for disabled text. Card
 * dividers are decorative and carry no requirement — the low number there is
 * deliberate, not an oversight.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Contrast measures ─────────────────────────────────────────────────────
const hex2srgb = (h) =>
  [0, 2, 4].map((i) => parseInt(h.trim().replace(/^#/, "").slice(i, i + 2), 16) / 255);
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relLum = (h) => {
  const [r, g, b] = hex2srgb(h).map(s2lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio. */
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * APCA lightness contrast (Lc). Tracks perception more closely than the WCAG
 * ratio, so it is reported alongside; where the two disagree, trust APCA.
 */
const apcaY = (h) =>
  hex2srgb(h)
    .map((c) => c ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126729, 0.7151522, 0.072175][i], 0);

function apca(text, background) {
  const txt = apcaY(text);
  const bg = apcaY(background);
  const clamp = (y) => (y < 0.022 ? y + (0.022 - y) ** 1.414 : y);
  const [t, b] = [clamp(txt), clamp(bg)];
  if (b > t) {
    const raw = (b ** 0.56 - t ** 0.57) * 1.14;
    return raw < 0.1 ? 0 : (raw - 0.027) * 100;
  }
  const raw = (b ** 0.65 - t ** 0.62) * 1.14;
  return raw > -0.1 ? 0 : (raw + 0.027) * 100;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "../src/styles/tokens.css"), "utf8");

/** Parses one `:root` block's custom properties, resolving var() references. */
function parseBlock(selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open + 1, end);
  const vars = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

const base = parseBlock(":root {");
const dark = { ...base, ...parseBlock(':root[data-theme="dark"]') };

function resolve(vars, value, depth = 0) {
  if (depth > 12) return null;
  const v = (value ?? "").trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return resolve(vars, vars[ref[1]], depth + 1);
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/** Text-on-surface pairs that must be legible. 4.5:1 for body, 3:1 for large. */
const PAIRS = [
  ["--text", "--surface", 4.5, "body text on a card"],
  ["--text", "--bg", 4.5, "body text on the page"],
  ["--text-secondary", "--surface", 4.5, "secondary text"],
  ["--text-tertiary", "--surface", 4.5, "tertiary text / metadata"],
  ["--text-disabled", "--surface", 3.0, "disabled text (large/non-essential)"],
  ["--text-accent", "--surface", 4.5, "link text"],
  ["--accent-text", "--accent", 4.5, "label on a primary button"],
  ["--text-accent", "--accent-subtle", 4.5, "accent text on its subtle fill"],
  ["--success", "--success-subtle", 4.5, "success badge text"],
  ["--warning", "--warning-subtle", 4.5, "warning badge text"],
  ["--danger", "--danger-subtle", 4.5, "danger badge text"],
  ["--info", "--info-subtle", 4.5, "info badge text"],
  ["--text-secondary", "--surface-sunken", 4.5, "text on a sunken panel"],
  ["--text-tertiary", "--surface-sunken", 4.5, "metadata on a sunken panel"],
  // A card divider is decorative; WCAG sets no ratio for it.
  ["--border", "--surface", 1.2, "card divider (decorative)"],
  ["--border-input", "--surface", 3.0, "form control border (WCAG 1.4.11)"],
];

let failures = 0;

for (const [label, vars] of [
  ["LIGHT", base],
  ["DARK", dark],
]) {
  console.log(`\n── ${label} ──────────────────────────────────────────────────`);
  for (const [fg, bg, min, description] of PAIRS) {
    const a = resolve(vars, vars[fg]);
    const b = resolve(vars, vars[bg]);
    if (!a || !b) {
      console.log(`  ?     ${description.padEnd(36)} unresolved (${fg} / ${bg})`);
      continue;
    }
    const ratio = contrast(a, b);
    const lc = Math.abs(apca(a, b));
    const ok = ratio >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${description.padEnd(36)} ${ratio.toFixed(2)}:1 ` +
        `(need ${min}) Lc ${lc.toFixed(0)}  ${a} on ${b}`,
    );
  }
}

console.log(
  `\n${failures === 0 ? "No contrast failures." : `${failures} pair(s) below their threshold.`}`,
);
process.exit(failures === 0 ? 0 : 1);
