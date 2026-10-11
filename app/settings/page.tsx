import Link from "next/link";
import { SettingsForm } from "@/components/SettingsForm";

export const metadata = { title: "Domains · Research Pulse" };

export default function SettingsPage() {
  return (
    <main>
      <header>
        <p className="window">
          <Link href="/" className="back">← Back to the brief</Link>
        </p>
        <h1>Monitored domains</h1>
      </header>
      <SettingsForm />
    </main>
  );
}
