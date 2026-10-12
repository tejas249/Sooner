import { describe, expect, it } from "vitest";
import type { Condition } from "../core/health.ts";
import { markSent, openAlerts, pruneResolvedAlerts, reconcileAlerts, recentlyResolved } from "./alerts.ts";
import { testDatabase } from "./testing/database.ts";

const db = testDatabase();
const T = new Date("2026-10-12T12:00:00Z");
const later = (minutes: number): Date => new Date(T.getTime() + minutes * 60_000);

const lag = (detail = "7 min behind"): Condition => ({ key: "queue-lag", severity: "critical", title: "Boards are being polled late", detail });
const gone = (id = "7"): Condition => ({ key: `board:${id}:gone`, severity: "warning", title: "Acme was switched off", detail: "moved" });

describe("reconcileAlerts", () => {
  it("opens an alert for a problem that is new, and offers it as a new notice", async () => {
    const { notices } = await reconcileAlerts(db.pool, [lag()], T);
    expect(notices).toEqual([{ kind: "new", ...lag() }]);
    const [row] = await openAlerts(db.pool);
    expect(row).toMatchObject({ key: "queue-lag", severity: "critical", detail: "7 min behind", sendCount: 0, lastSentAt: null, resolvedAt: null });
    expect(row?.openedAt.toISOString()).toBe(T.toISOString());
  });

  it("keeps offering it until the owner has really been told", async () => {
    await reconcileAlerts(db.pool, [lag()], T);
    // The send failed, so nothing was marked: the next pass offers it again.
    expect((await reconcileAlerts(db.pool, [lag()], later(1))).notices).toEqual([{ kind: "new", ...lag() }]);
  });

  it("says nothing more once the owner has been told", async () => {
    const { notices: first } = await reconcileAlerts(db.pool, [lag()], T);
    await markSent(db.pool, first, T);
    expect((await reconcileAlerts(db.pool, [lag()], later(5))).notices).toEqual([]);
    const [row] = await openAlerts(db.pool);
    expect(row).toMatchObject({ sendCount: 1 });
    expect(row?.lastSentAt?.toISOString()).toBe(T.toISOString());
  });

  it("reminds every hour for a critical alert and every six for a warning", async () => {
    const { notices: first } = await reconcileAlerts(db.pool, [lag(), gone()], T);
    await markSent(db.pool, first, T);

    expect((await reconcileAlerts(db.pool, [lag(), gone()], later(59))).notices).toEqual([]);
    const { notices: hour } = await reconcileAlerts(db.pool, [lag(), gone()], later(60));
    expect(hour.map((n) => [n.kind, n.key])).toEqual([["reminder", "queue-lag"]]);
    await markSent(db.pool, hour, later(60));

    expect((await reconcileAlerts(db.pool, [lag(), gone()], later(119))).notices).toEqual([]);
    const { notices: sixHours } = await reconcileAlerts(db.pool, [lag(), gone()], later(6 * 60));
    expect(sixHours.map((n) => [n.kind, n.key]).sort()).toEqual([
      ["reminder", "board:7:gone"],
      ["reminder", "queue-lag"],
    ]);
  });

  it("brings the text of an open alert up to date without making it a new alert", async () => {
    const { notices: first } = await reconcileAlerts(db.pool, [lag("7 min behind")], T);
    await markSent(db.pool, first, T);
    expect((await reconcileAlerts(db.pool, [lag("12 min behind")], later(2))).notices).toEqual([]);
    const [row] = await openAlerts(db.pool);
    expect(row).toMatchObject({ detail: "12 min behind", sendCount: 1 });
    expect(row?.openedAt.toISOString()).toBe(T.toISOString());
  });

  it("resolves an alert whose problem has gone, and tells the owner if they ever heard of it", async () => {
    const { notices: first } = await reconcileAlerts(db.pool, [lag(), gone()], T);
    await markSent(db.pool, first, T);
    const { notices } = await reconcileAlerts(db.pool, [gone()], later(10));
    expect(notices).toEqual([{ kind: "resolved", key: "queue-lag", severity: "critical", title: "Boards are being polled late", detail: "7 min behind" }]);
    expect((await openAlerts(db.pool)).map((r) => r.key)).toEqual(["board:7:gone"]);
    const [resolved] = await recentlyResolved(db.pool);
    expect(resolved?.key).toBe("queue-lag");
    expect(resolved?.resolvedAt?.toISOString()).toBe(later(10).toISOString());
  });

  it("resolves quietly an alert nobody was ever told about", async () => {
    await reconcileAlerts(db.pool, [lag()], T); // never marked as sent
    expect((await reconcileAlerts(db.pool, [], later(1))).notices).toEqual([]);
    expect(await openAlerts(db.pool)).toEqual([]);
  });

  it("opens a resolved alert again from scratch when the problem comes back", async () => {
    const { notices: first } = await reconcileAlerts(db.pool, [lag()], T);
    await markSent(db.pool, first, T);
    await reconcileAlerts(db.pool, [], later(10));
    const { notices } = await reconcileAlerts(db.pool, [lag("9 min behind")], later(30));
    expect(notices).toEqual([{ kind: "new", ...lag("9 min behind") }]);
    const [row] = await openAlerts(db.pool);
    expect(row).toMatchObject({ sendCount: 0, lastSentAt: null, resolvedAt: null, detail: "9 min behind" });
    expect(row?.openedAt.toISOString()).toBe(later(30).toISOString());
  });

  it("does nothing when there is nothing wrong and nothing open", async () => {
    expect((await reconcileAlerts(db.pool, [], T)).notices).toEqual([]);
  });

  it("can be run twice at once without opening anything twice", async () => {
    const results = await Promise.all([reconcileAlerts(db.pool, [lag(), gone()], T), reconcileAlerts(db.pool, [lag(), gone()], T)]);
    expect(results.flatMap((r) => r.notices).filter((n) => n.kind === "new")).toHaveLength(4); // each pass offers them: nobody has been told yet
    expect(await openAlerts(db.pool)).toHaveLength(2);
  });
});

describe("markSent", () => {
  it("counts each time the owner was told, and ignores resolved notices", async () => {
    const { notices } = await reconcileAlerts(db.pool, [lag()], T);
    await markSent(db.pool, notices, T);
    await markSent(db.pool, [{ kind: "reminder", ...lag() }], later(60));
    await markSent(db.pool, [{ kind: "resolved", ...lag() }], later(61));
    const [row] = await openAlerts(db.pool);
    expect(row).toMatchObject({ sendCount: 2 });
    expect(row?.lastSentAt?.toISOString()).toBe(later(60).toISOString());
  });

  it("does nothing for no notices", async () => {
    await markSent(db.pool, [], T);
  });
});

describe("pruneResolvedAlerts", () => {
  it("deletes alerts resolved more than thirty days ago and keeps the rest", async () => {
    const { notices: first } = await reconcileAlerts(db.pool, [lag(), gone("1"), gone("2")], T);
    await markSent(db.pool, first, T);
    await db.pool.query("update alert_state set resolved_at = $1 where key = 'queue-lag'", [new Date(T.getTime() - 31 * 86_400_000).toISOString()]);
    await db.pool.query("update alert_state set resolved_at = $1 where key = 'board:1:gone'", [new Date(T.getTime() - 5 * 86_400_000).toISOString()]);
    expect(await pruneResolvedAlerts(db.pool, T)).toBe(1);
    const { rows } = await db.pool.query<{ key: string }>("select key from alert_state order by key");
    expect(rows.map((r) => r.key)).toEqual(["board:1:gone", "board:2:gone"]);
  });
});
