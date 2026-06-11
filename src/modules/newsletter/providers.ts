import { config } from "../../config/index.js";

export interface EmailProvider {
  sendTransactionalEmail(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void>;
}

/** Development provider: logs instead of sending. */
class ConsoleProvider implements EmailProvider {
  async sendTransactionalEmail(input: { to: string; subject: string; html: string; text: string }) {
    console.log(`[email:console] to=${input.to} subject="${input.subject}"\n${input.text}`);
  }
}

class ResendProvider implements EmailProvider {
  async sendTransactionalEmail(input: { to: string; subject: string; html: string; text: string }) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  }
}

class PostmarkProvider implements EmailProvider {
  async sendTransactionalEmail(input: { to: string; subject: string; html: string; text: string }) {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": config.email.postmarkToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        From: config.email.from,
        To: input.to,
        Subject: input.subject,
        HtmlBody: input.html,
        TextBody: input.text,
        MessageStream: "outbound",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Postmark error ${res.status}: ${await res.text()}`);
  }
}

export function createEmailProvider(): EmailProvider {
  switch (config.email.provider) {
    case "resend":
      return new ResendProvider();
    case "postmark":
      return new PostmarkProvider();
    default:
      return new ConsoleProvider();
  }
}

/** Optional forwarding of confirmed subscribers to an external newsletter tool (PRD 5.9.4). */
export async function forwardSubscriberWebhook(email: string, event: "subscribed" | "unsubscribed"): Promise<void> {
  if (!config.email.webhookUrl) return;
  await fetch(config.email.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, event, source: "echopost", at: new Date().toISOString() }),
    signal: AbortSignal.timeout(15_000),
  });
}
