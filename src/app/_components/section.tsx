import type { ReactNode } from "react";

/** A titled block of the page. The heading names the section for screen readers as well as for the eye. */
export function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 py-14 sm:py-20">
      <h2 id={`${id}-title`} className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {intro ? <p className="mt-3 max-w-2xl text-lg text-muted">{intro}</p> : null}
      <div className="mt-8">{children}</div>
    </section>
  );
}
