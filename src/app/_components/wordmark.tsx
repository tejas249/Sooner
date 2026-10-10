/** The mark (a sun just above the horizon) and the name. The same drawing is the favicon in src/app/icon.svg. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-7">
        <rect width="32" height="32" rx="7" className="fill-ink" />
        <path d="M7 21a9 9 0 0 1 18 0z" className="fill-accent" />
        <rect x="5" y="22.5" width="22" height="2.2" rx="1.1" className="fill-canvas" />
      </svg>
      <span className="text-lg font-semibold tracking-tight">Sooner</span>
    </span>
  );
}
