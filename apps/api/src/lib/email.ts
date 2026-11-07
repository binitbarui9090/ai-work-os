/**
 * Outbound email.
 *
 * Three providers: real SMTP, a `console` provider that logs the message (the
 * local-development default), and `disabled`. The console provider is labelled
 * as such everywhere so nobody mistakes a logged email for a delivered one.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailResult =
  | { delivered: true; provider: "smtp"; messageId: string }
  | { delivered: false; provider: "console" | "disabled"; reason: string };

let transporter: Transporter | null = null;

function smtp(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }
  return transporter;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (env.EMAIL_PROVIDER === "disabled") {
    return { delivered: false, provider: "disabled", reason: "EMAIL_PROVIDER=disabled" };
  }

  if (env.EMAIL_PROVIDER === "console" || !env.SMTP_HOST) {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      "email (console provider — not actually sent)",
    );
    return {
      delivered: false,
      provider: "console",
      reason: env.SMTP_HOST
        ? "EMAIL_PROVIDER=console"
        : "EMAIL_PROVIDER=smtp but SMTP_HOST is not set",
    };
  }

  const info = await smtp().sendMail({
    from: env.EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return { delivered: true, provider: "smtp", messageId: info.messageId };
}

/** Minimal HTML wrapper so emails are readable in a client. */
export function emailLayout(title: string, bodyHtml: string, cta?: { url: string; label: string }): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="background:#4f46e5;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;color:#18181b">
<tr><td>
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">AI Work OS</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(title)}</h1>
${bodyHtml}
${button}
<p style="margin:28px 0 0;font-size:12px;color:#a1a1aa">You are receiving this because you are a member of a workspace on AI Work OS.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
