import "./globals.css";
export const metadata = {
  applicationName: "LoopDesk",
  title: "LoopDesk | Team & Project Management",
  description: "One workspace for organizations, projects, teams, meetings, and client requests.",
  icons: { icon: "/loopdesk-mark.svg", apple: "/loopdesk-mark.svg" },
};
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
