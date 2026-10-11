import { SettingsForm } from "@/components/SettingsForm";
import { PageHero } from "@/components/PageHero";

export const metadata = { title: "Domains · Research Pulse" };

export default function SettingsPage() {
  return (
    <>
      <PageHero title="Monitored domains" sub="Choose the research areas the brief watches each week. Changes apply from the next Monday run, with no code or redeploy." />
      <main className="wrap page">
        <SettingsForm />
      </main>
    </>
  );
}
