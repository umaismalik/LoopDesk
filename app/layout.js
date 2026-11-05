import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted by Next.js at build time (no runtime request to Google); exposed as --font-inter.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata = {
  applicationName: "LoopDesk",
  title: "LoopDesk | Team & Project Management",
  description: "One workspace for organizations, projects, teams, meetings, and client requests.",
  icons: { icon: "/loopdesk-mark.svg", apple: "/loopdesk-mark.svg" },
};
export default function RootLayout({ children }) {
  return (<html lang="en" className={inter.variable}><body>{children}</body></html>);
}
