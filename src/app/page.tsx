import boardsFile from "../../data/boards.json";
import { BoardEntries } from "../core/boards.ts";
import { REPO_URL } from "../web/site.ts";
import { siteStats } from "../web/site-stats.ts";
import { CompanyList } from "./_components/company-list.tsx";
import { Section } from "./_components/section.tsx";

// The numbers on this page come from data/boards.json, checked against its schema when the page is built, so a mistake in
// the list fails the build instead of reaching the site.
const stats = siteStats(BoardEntries.parse(boardsFile));

const steps = [
  {
    title: "Ask politely",
    body: "Each company publishes its open roles as a public feed. Sooner asks for it every few minutes, never faster than one request a second to any provider. An answer of “nothing changed” costs a few hundred bytes.",
  },
  {
    title: "Compare carefully",
    body: "The new list is compared with the last one. A role has to be missing on two checks in a row before it counts as closed, and a board that suddenly loses 40% of its roles is held back instead of believed.",
  },
  {
    title: "Tell you first",
    body: "A new role at a company you follow will reach you by email, push or Telegram, with how long ago the employer posted it.",
    soon: true,
  },
];

const worksToday = [
  "Reads the public job boards on Greenhouse, Lever and Ashby",
  "Finds roles that are new, edited, closed or back again",
  "Never reads a failed or odd answer as “everything closed”",
  "Is covered by automated tests, including randomised ones",
];

const nextUp = [
  "A database that keeps the history of every role",
  "Search, and a page for each company",
  "Alerts by email, push and Telegram",
  "A stale-role signal that shows its reasons",
];

const principles = [
  {
    title: "A signal, never a verdict",
    body: "Companies keep roles open for honest reasons. Sooner will show how long a role has been open and why it might be stale. It will not call anyone’s posting a ghost job.",
  },
  {
    title: "Links go to the employer",
    body: "Every role links to the employer’s own page. Sooner does not host applications, copy descriptions or use company logos.",
  },
  {
    title: "Only public feeds",
    body: "Sooner reads the feeds companies publish for exactly this purpose, says who it is in every request, and does not scrape sites that have no feed.",
  },
];

function Check({ done }: { done: boolean }) {
  return done ? (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent-ink">
      <path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted">
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="3 3" />
    </svg>
  );
}

export default function Home() {
  const facts = [
    { label: "Companies watched", value: String(stats.companies) },
    { label: "Job-board providers", value: String(stats.providers) },
    { label: "Open roles when the list was confirmed", value: stats.roles.toLocaleString("en-US") },
    { label: "Most requests a second to any provider", value: "1" },
  ];

  return (
    <main id="main" className="mx-auto max-w-5xl px-5 sm:px-8">
      <div className="relative isolate pb-14 pt-14 sm:pb-20 sm:pt-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-2 -z-10 h-72 w-[min(56rem,100vw)] -translate-x-1/2 rounded-full bg-accent-soft opacity-80 blur-3xl"
        />
        <p className="font-mono text-sm text-accent-ink">Early warning for job openings</p>
        <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-tight text-balance sm:text-7xl sm:leading-[1.02]">
          Know when a role opens, <span className="text-accent-ink">sooner.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted text-pretty sm:text-xl">
          Sooner watches the public job boards of the companies you care about. It tells you the moment a role appears, how
          long each role has really been open, and whether the company fills its roles at all.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a
            href="#companies"
            className="inline-flex items-center rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-85"
          >
            See who it watches
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface-2"
          >
            Read the code
          </a>
        </div>
        <p className="mt-6 max-w-xl text-sm text-muted">
          This is a working prototype. The polling runs today; accounts and alerts are what comes next.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label} className="bg-surface p-5 sm:p-6">
            <dt className="text-sm text-muted">{fact.label}</dt>
            <dd className="mt-2 font-mono text-3xl font-medium tracking-tight tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <Section id="how" title="How it works">
        <ol className="grid gap-4 sm:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title} className="rounded-2xl border border-line bg-surface p-6">
              <p className="flex items-center gap-2 font-mono text-sm text-muted">
                {String(index + 1).padStart(2, "0")}
                {step.soon ? (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-ink">Coming next</span>
                ) : null}
              </p>
              <h3 className="mt-3 text-lg font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="stands" title="Where it stands" intro="Built in the open, one honest step at a time.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-6">
            <h3 className="font-semibold tracking-tight">Works today</h3>
            <ul className="mt-4 space-y-3">
              {worksToday.map((item) => (
                <li key={item} className="flex gap-3">
                  <Check done />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-surface-2 p-6">
            <h3 className="font-semibold tracking-tight">Next</h3>
            <ul className="mt-4 space-y-3 text-muted">
              {nextUp.map((item) => (
                <li key={item} className="flex gap-3">
                  <Check done={false} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="honest" title="Honest by design">
        <div className="grid gap-8 sm:grid-cols-3">
          {principles.map((principle) => (
            <div key={principle.title} className="border-t border-line pt-5">
              <h3 className="font-semibold tracking-tight">{principle.title}</h3>
              <p className="mt-2 text-muted">{principle.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="companies"
        title="Companies it watches"
        intro={`${stats.companies} boards today, picked for a mix of global tech, Indian companies and remote-first teams. The list grows toward 300.`}
      >
        <CompanyList groups={stats.bySegment} />
      </Section>
    </main>
  );
}
