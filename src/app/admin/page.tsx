import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OUTCOME_TEXT, isOutcome } from "../../web/admin-actions.ts";
import { loadOverview, type Overview } from "../../web/admin-data.ts";
import { webPool } from "../../web/db.ts";
import { AlertList } from "./_components/alerts.tsx";
import { BoardTable } from "./_components/board-table.tsx";
import { Tiles } from "./_components/tiles.tsx";
import { requireAdmin } from "./auth.ts";

// Always read fresh from the database: this page is a live instrument, never a cached one.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

const link = "rounded-md px-1 underline underline-offset-4 hover:text-ink";

function Frame({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="mx-auto max-w-6xl px-5 pb-20 pt-6 sm:px-8">
      {children}
    </main>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Frame>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-4 max-w-2xl space-y-3 text-muted">{children}</div>
    </Frame>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ show?: string; notice?: string }> }) {
  await requireAdmin();
  const { show, notice } = await searchParams;

  const pool = webPool();
  if (!pool) {
    return (
      <Message title="Admin">
        <p>
          There is no database to show. Set <code className="font-mono text-ink">DATABASE_URL</code> where this site runs (use the
          database&apos;s pooled connection string here), and this page will list the worker, its alerts and every board.
        </p>
      </Message>
    );
  }

  let overview: Overview;
  try {
    overview = await loadOverview(pool, new Date());
  } catch (error) {
    // The reason can name the database host, so it goes to the server log and not to the page.
    console.error("admin: could not read the database:", error instanceof Error ? error.message : "unknown error");
    return (
      <Message title="Admin">
        <p>The database could not be read. This page does not say why; the reason is in this site&apos;s server log.</p>
        <p>
          <a href="/admin" className={link}>
            Try again
          </a>
        </p>
      </Message>
    );
  }

  const attentionOnly = show === "attention";
  const boards = attentionOnly ? overview.boards.filter((board) => board.attention) : overview.boards;
  const attention = overview.boards.filter((board) => board.attention).length;

  return (
    <Frame>
      <p className="text-sm text-muted">Admin</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">The worker and its boards</h1>
      <p className="mt-2 text-sm text-muted">
        As of <time dateTime={overview.generatedAt.toISOString()}>{overview.generatedAt.toUTCString()}</time> ·{" "}
        <a href="/admin" className={link}>
          Refresh
        </a>
      </p>

      {notice && isOutcome(notice) ? (
        <p role="status" className="mt-5 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
          {OUTCOME_TEXT[notice]}
        </p>
      ) : null}

      <section aria-labelledby="health-title" className="mt-8">
        <h2 id="health-title" className="sr-only">
          Health
        </h2>
        <Tiles tiles={overview.tiles} />
      </section>

      <section aria-labelledby="alerts-title" className="mt-12">
        <h2 id="alerts-title" className="text-xl font-semibold tracking-tight">
          Open alerts
        </h2>
        <div className="mt-4">
          <AlertList alerts={overview.alerts} empty="Nothing is wrong right now." />
        </div>
      </section>

      <section aria-labelledby="boards-title" className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="boards-title" className="text-xl font-semibold tracking-tight">
            Boards
          </h2>
          <nav aria-label="Which boards to show" className="flex gap-4 text-sm">
            <a href="/admin" aria-current={attentionOnly ? undefined : "page"} className={`${link} ${attentionOnly ? "text-muted" : "font-medium"}`}>
              All ({overview.boards.length})
            </a>
            <a
              href="/admin?show=attention"
              aria-current={attentionOnly ? "page" : undefined}
              className={`${link} ${attentionOnly ? "font-medium" : "text-muted"}`}
            >
              Needs attention ({attention})
            </a>
          </nav>
        </div>
        <div className="mt-4">
          {attentionOnly && boards.length === 0 ? <p className="text-muted">No board needs attention.</p> : <BoardTable boards={boards} />}
        </div>
        <p className="mt-3 max-w-3xl text-sm text-muted">
          &ldquo;Poll now&rdquo; makes a board due; the worker polls it at its next pass, keeping to the politeness rules. &ldquo;Pause&rdquo;
          switches a board off without touching its roles, and &ldquo;Resume&rdquo; switches it back on.
        </p>
      </section>

      {overview.resolvedAlerts.length > 0 ? (
        <section aria-labelledby="resolved-title" className="mt-12">
          <h2 id="resolved-title" className="text-xl font-semibold tracking-tight">
            Recently resolved
          </h2>
          <div className="mt-4">
            <AlertList alerts={overview.resolvedAlerts} empty="" />
          </div>
        </section>
      ) : null}
    </Frame>
  );
}
