import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-5 py-24 sm:px-8">
      <p className="font-mono text-sm text-accent-ink">404</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">That page isn&apos;t here.</h1>
      <p className="mt-4 max-w-xl text-lg text-muted">
        It may have moved, or it may never have existed. The home page lists everything there is so far.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex w-fit items-center rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-85"
      >
        Back to the home page
      </Link>
    </main>
  );
}
