import type { Notice, NoticeKind } from "../core/health.ts";

export type { Notice, NoticeKind };

/** Telling the owner. A notifier delivers a batch of notices (see core/health.ts) to a chat channel. */

export interface Notifier {
  /** Delivers the notices, or throws if it could not. The error never contains the address it posted to. */
  send(notices: readonly Notice[]): Promise<void>;
  /** What kind of channel this is, for the log: "discord", "slack", "telegram" or "webhook". Never the address. */
  readonly channel: string;
}

/** A message is split before it gets this long. Discord's limit is 2000 characters, Telegram's 4096. */
const MAX_MESSAGE = 1800;
/** More notices of one kind than this in one batch are summarised in a line each instead of described in full. */
const FULL_DETAIL_LIMIT = 4;

const LABEL: Record<NoticeKind, string> = { new: "NEW", reminder: "STILL OPEN", resolved: "RESOLVED" };

function describeOne(notice: Notice): string {
  const head = `${notice.kind === "new" ? notice.severity.toUpperCase() : LABEL[notice.kind]}: ${notice.title}`;
  return notice.kind === "resolved" ? head : `${head}\n${notice.detail}`;
}

/**
 * Turns a batch of notices into plain-text messages. Few notices are described in full; when a provider breaks and forty
 * boards fail at once, they are summarised in a line each, so the owner gets one message and not forty.
 */
export function renderNotices(notices: readonly Notice[]): string[] {
  if (notices.length === 0) return [];
  const lines: string[] = [];
  for (const kind of ["new", "reminder", "resolved"] as const) {
    const group = notices.filter((notice) => notice.kind === kind);
    if (group.length === 0) continue;
    if (group.length <= FULL_DETAIL_LIMIT) {
      lines.push(...group.map(describeOne));
    } else {
      const counts = (["critical", "warning"] as const)
        .map((severity) => [severity, group.filter((n) => n.severity === severity).length] as const)
        .filter(([, n]) => n > 0)
        .map(([severity, n]) => `${n} ${severity}`)
        .join(", ");
      lines.push(`${LABEL[kind]}: ${group.length} alerts (${counts})\n${group.map((n) => `- ${n.title}`).join("\n")}`);
    }
  }
  // Pack the pieces into messages that fit, never cutting a piece in the middle unless it alone is too long.
  const messages: string[] = [];
  let current = "";
  for (const line of lines) {
    const piece = line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
    if (current !== "" && current.length + piece.length + 2 > MAX_MESSAGE) {
      messages.push(current);
      current = piece;
    } else {
      current = current === "" ? piece : `${current}\n\n${piece}`;
    }
  }
  if (current !== "") messages.push(current);
  return messages.map((text) => `Sooner\n${text}`);
}

export interface NotifierOptions {
  /** A chat webhook: Discord, Slack, or any URL that accepts a JSON POST. Must be https (plain http only to this machine). */
  webhookUrl?: string;
  telegram?: { botToken: string; chatId: string };
  /** Only a test changes this. */
  telegramBaseUrl?: string;
  timeoutMs?: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Slack reads &, < and > in a message as markup, and provider text can contain them. */
const escapeSlack = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type WebhookFlavour = "discord" | "slack" | "webhook";

/** What each kind of webhook expects in the body of the POST. */
export function webhookBody(flavour: WebhookFlavour, text: string): Record<string, unknown> {
  switch (flavour) {
    case "discord":
      // Provider text can contain @everyone; an empty list of allowed mentions means nothing in the message pings anyone.
      return { content: text, username: "Sooner", allowed_mentions: { parse: [] } };
    case "slack":
      return { text: escapeSlack(text) };
    case "webhook":
      return { text, content: text };
  }
}

export function webhookFlavour(url: URL): WebhookFlavour {
  if (/(^|\.)(discord|discordapp)\.com$/.test(url.hostname) && url.pathname.startsWith("/api/webhooks/")) return "discord";
  if (url.hostname === "hooks.slack.com") return "slack";
  return "webhook";
}

async function post(url: string, body: unknown, timeoutMs: number): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Sooner-alerts/0.1" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The address is a secret, so only the kind of failure is reported. (The logger writes an error's message, not its cause.)
    const reason = error instanceof DOMException && error.name === "TimeoutError" ? "timed out" : "could not connect";
    throw new Error(`the alert channel ${reason}`, { cause: error });
  }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`the alert channel answered HTTP ${response.status}`);
}

/** Builds the notifier for the configured channel, or null when none is configured. */
export function createNotifier(options: NotifierOptions): Notifier | null {
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (options.webhookUrl) {
    const url = new URL(options.webhookUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      throw new Error("the alert webhook must be an https address");
    }
    const flavour = webhookFlavour(url);
    return {
      channel: flavour,
      async send(notices) {
        for (const text of renderNotices(notices)) {
          await post(options.webhookUrl as string, webhookBody(flavour, text), timeoutMs);
        }
      },
    };
  }

  if (options.telegram) {
    const { botToken, chatId } = options.telegram;
    const base = options.telegramBaseUrl ?? "https://api.telegram.org";
    return {
      channel: "telegram",
      async send(notices) {
        for (const text of renderNotices(notices)) {
          await post(`${base}/bot${botToken}/sendMessage`, { chat_id: chatId, text, disable_web_page_preview: true }, timeoutMs);
        }
      },
    };
  }
  return null;
}
