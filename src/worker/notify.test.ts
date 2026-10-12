import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNotifier, renderNotices, webhookBody, webhookFlavour, type Notice } from "./notify.ts";

const notice = (over: Partial<Notice> = {}): Notice => ({
  kind: "new",
  key: "queue-lag",
  severity: "critical",
  title: "Boards are being polled late",
  detail: "The most overdue board is 7 min behind.",
  ...over,
});

describe("renderNotices", () => {
  it("is nothing for no notices", () => {
    expect(renderNotices([])).toEqual([]);
  });

  it("describes a new alert with its severity, title and detail", () => {
    expect(renderNotices([notice()])).toEqual(["Sooner\nCRITICAL: Boards are being polled late\nThe most overdue board is 7 min behind."]);
  });

  it("marks a reminder, and a resolution without repeating the detail", () => {
    const [message] = renderNotices([notice({ kind: "reminder" }), notice({ kind: "resolved", title: "Old problem", key: "x" })]);
    expect(message).toContain("STILL OPEN: Boards are being polled late\nThe most overdue board");
    expect(message).toContain("RESOLVED: Old problem");
    expect(message).not.toContain("RESOLVED: Old problem\n");
  });

  it("describes up to four alerts in full and summarises more than that in one line each", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      notice({ key: `board:${i}:format`, title: `Company ${i}: the feed changed shape`, detail: `detail ${i}`, severity: i < 2 ? "warning" : "critical" }),
    );
    const [message, ...rest] = renderNotices(many);
    expect(rest).toEqual([]);
    expect(message).toContain("NEW: 12 alerts (10 critical, 2 warning)");
    expect(message).toContain("- Company 0: the feed changed shape");
    expect(message).toContain("- Company 11: the feed changed shape");
    expect(message).not.toContain("detail 5"); // the detail of each would be forty messages' worth
    expect(four(4)).toContain("detail 3");
    expect(four(5)).not.toContain("detail 3");

    function four(n: number): string {
      return (renderNotices(Array.from({ length: n }, (_, i) => notice({ key: `k${i}`, detail: `detail ${i}` })))[0]) ?? "";
    }
  });

  it("keeps each message under the limit by splitting, and cuts a single piece that is too long", () => {
    const notices = Array.from({ length: 4 }, (_, i) => notice({ key: `k${i}`, detail: "x".repeat(700) }));
    const messages = renderNotices(notices);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(1810);
    const huge = renderNotices([notice({ detail: "y".repeat(5000) })]);
    expect(huge).toHaveLength(1);
    expect(huge[0]?.length).toBeLessThanOrEqual(1810);
    expect(huge[0]?.endsWith("…")).toBe(true);
  });
});

describe("createNotifier", () => {
  let server: http.Server;
  let base = "";
  let requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
  let respond: (res: http.ServerResponse) => void = (res) => res.writeHead(204).end();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "null") as unknown });
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    requests = [];
    respond = (res) => res.writeHead(204).end();
  });

  it("is null when no channel is configured", () => {
    expect(createNotifier({})).toBeNull();
  });

  it("refuses a webhook that is not https, except to this machine", () => {
    expect(() => createNotifier({ webhookUrl: "http://example.com/hook" })).toThrow(/https/);
    expect(() => createNotifier({ webhookUrl: "ftp://example.com/hook" })).toThrow(/https/);
    expect(createNotifier({ webhookUrl: "https://example.com/hook" })?.channel).toBe("webhook");
    expect(createNotifier({ webhookUrl: `${base}/hook` })?.channel).toBe("webhook");
  });

  it("recognises Discord and Slack by their addresses", () => {
    expect(createNotifier({ webhookUrl: "https://discord.com/api/webhooks/1/abc" })?.channel).toBe("discord");
    expect(createNotifier({ webhookUrl: "https://discordapp.com/api/webhooks/1/abc" })?.channel).toBe("discord");
    expect(createNotifier({ webhookUrl: "https://hooks.slack.com/services/T/B/x" })?.channel).toBe("slack");
    expect(createNotifier({ webhookUrl: "https://discord.com/somewhere/else" })?.channel).toBe("webhook");
    expect(createNotifier({ webhookUrl: "https://notdiscord.com/api/webhooks/1/abc" })?.channel).toBe("webhook");
  });

  it("posts a generic JSON message that carries the text under both names chat tools use", async () => {
    await createNotifier({ webhookUrl: `${base}/hook` })?.send([notice()]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/hook");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[0]?.body).toEqual({ text: expect.stringContaining("Boards are being polled late") as string, content: expect.stringContaining("Boards are being polled late") as string });
  });

  it("posts nothing for no notices", async () => {
    await createNotifier({ webhookUrl: `${base}/hook` })?.send([]);
    expect(requests).toEqual([]);
  });

  it("sends Telegram messages to the bot API with the chat id", async () => {
    const notifier = createNotifier({ telegram: { botToken: "123:ABC", chatId: "-100999" }, telegramBaseUrl: base });
    expect(notifier?.channel).toBe("telegram");
    await notifier?.send([notice()]);
    expect(requests[0]?.url).toBe("/bot123:ABC/sendMessage");
    expect(requests[0]?.body).toMatchObject({ chat_id: "-100999", disable_web_page_preview: true });
  });

  it("prefers the webhook when both are configured", () => {
    expect(createNotifier({ webhookUrl: `${base}/hook`, telegram: { botToken: "1:a", chatId: "2" } })?.channel).toBe("webhook");
  });

  it("sends one request per message when a batch needs several", async () => {
    const notifier = createNotifier({ webhookUrl: `${base}/hook` });
    await notifier?.send(Array.from({ length: 4 }, (_, i) => notice({ key: `k${i}`, detail: "x".repeat(700) })));
    expect(requests.length).toBeGreaterThan(1);
  });

  it("reports a refusal without revealing the address it posted to", async () => {
    respond = (res) => res.writeHead(404).end();
    const error = await createNotifier({ webhookUrl: `${base}/secret-path-123` })?.send([notice()]).catch((e: unknown) => e);
    expect((error as Error).message).toBe("the alert channel answered HTTP 404");
    expect((error as Error).message).not.toContain("secret-path-123");
  });

  it("reports a connection that cannot be made without revealing the address", async () => {
    const error = await createNotifier({ webhookUrl: "http://127.0.0.1:1/very-secret-token" })?.send([notice()]).catch((e: unknown) => e);
    expect((error as Error).message).toBe("the alert channel could not connect");
  });

  it("gives up on a channel that never answers", async () => {
    respond = () => undefined;
    const error = await createNotifier({ webhookUrl: `${base}/hook`, timeoutMs: 80 })?.send([notice()]).catch((e: unknown) => e);
    expect((error as Error).message).toBe("the alert channel timed out");
  });

  it("does not follow a redirect to somewhere else", async () => {
    respond = (res) => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
    const error = await createNotifier({ webhookUrl: `${base}/hook` })?.send([notice()]).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^the alert channel (could not connect|answered HTTP 302)$/);
  });

});

describe("what each kind of webhook is sent", () => {
  it("tells Discord not to ping anyone, whatever the text says", () => {
    expect(webhookBody("discord", "role id @everyone appears twice")).toEqual({
      content: "role id @everyone appears twice",
      username: "Sooner",
      allowed_mentions: { parse: [] },
    });
  });

  it("escapes the characters Slack reads as markup", () => {
    expect(webhookBody("slack", "<!channel> a & b <https://evil.example|click>")).toEqual({
      text: "&lt;!channel&gt; a &amp; b &lt;https://evil.example|click&gt;",
    });
  });

  it("sends anything else the text under both names", () => {
    expect(webhookBody("webhook", "hi")).toEqual({ text: "hi", content: "hi" });
  });

  it("works out the kind from the address", () => {
    expect(webhookFlavour(new URL("https://discord.com/api/webhooks/1/abc"))).toBe("discord");
    expect(webhookFlavour(new URL("https://hooks.slack.com/services/a/b/c"))).toBe("slack");
    expect(webhookFlavour(new URL("https://example.com/hook"))).toBe("webhook");
  });
});
