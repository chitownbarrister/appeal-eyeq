// Billing email through Postmark's API (POSTMARK_API_URL lets tests use a stand-in).
// POSTMARK_SERVER_TOKEN and POSTMARK_FROM (an address on a domain verified in Postmark)
// live in Render's environment. Without them, nothing is sent and the app says so.

export const emailConfigured = () => Boolean(process.env.POSTMARK_SERVER_TOKEN && process.env.POSTMARK_FROM);

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
  fromName?: string | null;
  attachments?: { name: string; content: Buffer; contentType: string }[];
}

export async function sendEmail(m: OutgoingEmail): Promise<{ id: string }> {
  if (!emailConfigured()) throw Object.assign(new Error("not configured"), { notConfigured: true });
  const from = process.env.POSTMARK_FROM!;
  const fromHeader = m.fromName ? `"${m.fromName.replace(/["\r\n]/g, "")}" <${from.replace(/^.*<|>.*$/g, "")}>` : from;
  const res = await fetch(`${(process.env.POSTMARK_API_URL || "https://api.postmarkapp.com").replace(/\/$/, "")}/email`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN! },
    body: JSON.stringify({
      From: fromHeader, To: m.to.join(", "), ReplyTo: m.replyTo || undefined, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: "outbound",
      Attachments: (m.attachments ?? []).map((a) => ({ Name: a.name, Content: a.content.toString("base64"), ContentType: a.contentType })),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string; ErrorCode?: number };
  if (!res.ok || (data.ErrorCode && data.ErrorCode !== 0)) throw new Error(data.Message || `Postmark returned ${res.status}`);
  return { id: data.MessageID ?? "" };
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const validEmail = (s: string) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s) && s.length <= 200;
