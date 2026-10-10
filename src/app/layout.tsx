import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { REPO_URL, siteUrl } from "../web/site.ts";
import { Wordmark } from "./_components/wordmark.tsx";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const title = "Sooner: know when a role opens";
const description =
  "Sooner watches the public job boards of the companies you care about. It tells you the moment a role appears, how long each role has really been open, and whether the company fills its roles at all.";

export const metadata: Metadata = {
  metadataBase: siteUrl(process.env),
  title: { default: title, template: "%s · Sooner" },
  description,
  openGraph: { title, description, siteName: "Sooner", type: "website" },
  twitter: { card: "summary", title, description },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf8" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0f12" },
  ],
};

const navLink =
  "rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-ink focus-visible:text-ink";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-canvas"
        >
          Skip to content
        </a>
        <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <Link href="/" aria-label="Sooner, home">
            <Wordmark />
          </Link>
          <nav aria-label="Main" className="flex items-center gap-0.5 sm:gap-1">
            <Link href="/#how" className={`${navLink} hidden sm:inline-block`}>
              How it works
            </Link>
            <Link href="/#stands" className={`${navLink} hidden sm:inline-block`}>
              Where it stands
            </Link>
            <Link href="/#companies" className={navLink}>
              Companies
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-2"
            >
              GitHub
            </a>
          </nav>
        </header>
        {children}
        <footer className="mx-auto max-w-5xl border-t border-line px-5 py-10 text-sm text-muted sm:px-8">
          <p className="max-w-2xl">
            Sooner is an independent project and is not affiliated with any employer or job board. Company names are shown
            as text, and every role links to the employer&apos;s own page.
          </p>
          <p className="mt-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block py-1 underline underline-offset-4 hover:text-ink"
            >
              Source code
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
