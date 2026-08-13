import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Chrome } from "@/components/chrome";
import { Providers } from "./providers";
import "./globals.css";

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
    <html lang="en" suppressHydrationWarning>
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
