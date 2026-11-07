/**
 * Markdown ⇄ document blocks.
 *
 * The editor stores a flat array of typed blocks rather than a Markdown string:
 * blocks are what the UI renders and what collaborative edits address. Markdown
 * is the interchange format for AI-authored content and for export.
 */
import type { DocBlock } from "@workos/shared";
import { randomUUID } from "node:crypto";

export function markdownToBlocks(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];

  let paragraph: string[] = [];
  let codeLines: string[] | null = null;
  let codeLanguage = "";

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ id: randomUUID(), type: "paragraph", text });
    paragraph = [];
  };

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (codeLines === null) {
        flushParagraph();
        codeLines = [];
        codeLanguage = fence[1] ?? "";
      } else {
        blocks.push({
          id: randomUUID(),
          type: "code",
          text: codeLines.join("\n"),
          language: codeLanguage || undefined,
        });
        codeLines = null;
        codeLanguage = "";
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        id: randomUUID(),
        type: "heading",
        level: Math.min(3, heading[1]!.length) as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ id: randomUUID(), type: "divider" });
      continue;
    }

    const todo = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      flushParagraph();
      blocks.push({
        id: randomUUID(),
        type: "todo",
        checked: todo[1]!.toLowerCase() === "x",
        text: todo[2]!.trim(),
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ id: randomUUID(), type: "bullet", text: bullet[1]!.trim() });
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({ id: randomUUID(), type: "numbered", text: numbered[1]!.trim() });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ id: randomUUID(), type: "quote", text: quote[1]!.trim() });
      continue;
    }

    paragraph.push(line.trim());
  }

  // An unterminated code fence still yields its content rather than losing it.
  if (codeLines !== null) {
    blocks.push({
      id: randomUUID(),
      type: "code",
      text: codeLines.join("\n"),
      language: codeLanguage || undefined,
    });
  }
  flushParagraph();

  return blocks.length ? blocks : [{ id: randomUUID(), type: "paragraph", text: "" }];
}

export function blocksToMarkdown(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const out: string[] = [];
  for (const raw of blocks) {
    const block = raw as DocBlock;
    if (!block || typeof block !== "object") continue;
    const text = typeof block.text === "string" ? block.text : "";
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(block.level ?? 2)} ${text}`);
        break;
      case "bullet":
        out.push(`- ${text}`);
        break;
      case "numbered":
        out.push(`1. ${text}`);
        break;
      case "todo":
        out.push(`- [${block.checked ? "x" : " "}] ${text}`);
        break;
      case "code":
        out.push(`\`\`\`${block.language ?? ""}\n${text}\n\`\`\``);
        break;
      case "quote":
        out.push(`> ${text}`);
        break;
      case "divider":
        out.push("---");
        break;
      default:
        out.push(text);
    }
  }
  return out.join("\n\n").trim();
}

/** Plain text for full-text search and AI context (no Markdown syntax). */
export function blocksToPlainText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as DocBlock[])
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "divider") return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();
}

/** Normalises blocks from a client: assigns ids, drops unknown types. */
export function sanitiseBlocks(input: unknown): DocBlock[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set([
    "heading",
    "paragraph",
    "bullet",
    "numbered",
    "todo",
    "code",
    "quote",
    "divider",
  ]);

  return input
    .slice(0, 5000)
    .flatMap((raw): DocBlock[] => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as Record<string, unknown>;
      const type = typeof candidate.type === "string" ? candidate.type : "paragraph";
      if (!allowed.has(type)) return [];

      const block: DocBlock = {
        id: typeof candidate.id === "string" && candidate.id.length <= 64 ? candidate.id : randomUUID(),
        type: type as DocBlock["type"],
      };
      if (typeof candidate.text === "string") block.text = candidate.text.slice(0, 20000);
      if (type === "heading") {
        const level = Number(candidate.level);
        block.level = (level === 1 || level === 2 || level === 3 ? level : 2) as 1 | 2 | 3;
      }
      if (type === "todo") block.checked = Boolean(candidate.checked);
      if (type === "code" && typeof candidate.language === "string") {
        block.language = candidate.language.slice(0, 24);
      }
      return [block];
    });
}
