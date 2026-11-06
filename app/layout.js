import "./globals.css";

export const metadata = {
  applicationName: "LoopDesk",
  title: "LoopDesk | Team & Project Management",
  description: "One workspace for organizations, projects, teams, meetings, and client requests.",
  icons: { icon: "/loopdesk-mark.svg", apple: "/loopdesk-mark.svg" },
};
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0f1530" };
export default function RootLayout({ children }) {
  return (<html lang="en">
    <head>
      {/* Plus Jakarta Sans is loaded by the browser from Google Fonts, so the build never has to download it.
          If it cannot load, the page falls back to Segoe UI / system fonts without breaking layout. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" />
    </head>
    <body>{children}</body>
  </html>);
}
