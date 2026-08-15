import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Chrome } from "@/components/chrome";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Typography.
 *
 * Nothing was set at all, which meant the design rendered in whatever
 * `system-ui` resolved to — different metrics on macOS, Windows and Linux, so
 * spacing that looked right on one was wrong on another.
 *
 * Inter rather than a geometric face like Poppins, and the reason is in the
 * markup: this UI uses `tabular-nums` in fourteen places (metric tiles, audit
 * counts, calendar dates) and `text-xs` in over a hundred. Inter was drawn for
 * interfaces at small sizes and carries a real tabular figure set, so columns
 * of numbers line up. Poppins is a display face — wide, single-storey `a`,
 * circular bowls — with no tabular figures in its Google Fonts release, so
 * those columns would visibly stagger and 11px labels would lose definition.
 * Personality belongs in the wordmark, not in the font the audit log is set in.
 *
 * Self-hosted by next/font at build time: no request to Google at runtime,
 * which matters for a project people run on their own infrastructure.
 */
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zest — AI social media operations agent",
  description:
    "It researches, drafts, schedules, publishes, replies, and learns. You approve until you trust it.",
};

/**
 * Applies the theme class before first paint. HeroUI keys its dark tokens off
 * `.dark`, so without this the page renders light components on whatever
 * background the OS theme implies.
 */
const themeScript = `(function(){try{var s=localStorage.getItem("zest-theme");var d=s==="dark"||(!s&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>
          <Chrome>{children}</Chrome>
        </Providers>
      </body>
    </html>
  );
}
