"use client";

import { useEffect, useState } from "react";

interface Row {
  id: string;
  name: string;
  intentNote: string;
  catsText: string;
  kwText: string;
  exText: string;
  maxPapers: number;
  active: boolean;
  isNew?: boolean;
  busy?: boolean;
  msg?: string;
}

const split = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const slug = (name: string, taken: string[]) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "domain";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};
const key = () => {
  try {
    return sessionStorage.getItem("rp-admin") ?? "";
  } catch {
    return "";
  }
};

export function SettingsForm() {
  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState<{ source: string; max: number; writable: boolean; needsPasscode: boolean } | null>(null);
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [passMsg, setPassMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const remembered = key();
    setPass(remembered);
    if (remembered) void unlock(remembered, true);
    fetch("/api/domains")
      .then((r) => r.json())
      .then((j) => {
        setMeta({ source: j.source, max: j.max, writable: j.writable, needsPasscode: j.needsPasscode });
        setRows(
          j.domains.map((d: any) => ({
            id: d.id,
            name: d.name,
            intentNote: d.intentNote,
            catsText: d.arxivCats.join(", "),
            kwText: d.keywords.join(", "),
            exText: d.excludeKeywords.join(", "),
            maxPapers: d.maxPapers,
            active: d.active,
          })),
        );
      })
      .catch(() => setStatus({ kind: "err", text: "Could not load domains." }));
  }, []);

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const headers = () => ({ "Content-Type": "application/json", "x-admin-key": pass.trim() });

  /** Checks the passcode with the server before any edits, so a typo shows up straight away. */
  async function unlock(value = pass, quiet = false) {
    if (!value.trim()) return;
    setChecking(true);
    if (!quiet) setPassMsg(null);
    try {
      const res = await fetch("/api/admin/check", { method: "POST", headers: { "x-admin-key": value.trim() } });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setUnlocked(true);
        setPassMsg({ kind: "ok", text: "Unlocked. You can edit and save your domains." });
        try {
          sessionStorage.setItem("rp-admin", value.trim());
        } catch {}
      } else {
        setUnlocked(false);
        try {
          sessionStorage.removeItem("rp-admin");
        } catch {}
        if (!quiet) setPassMsg({ kind: "err", text: j.error ?? "That passcode was not accepted." });
      }
    } catch {
      setPassMsg({ kind: "err", text: "Could not reach the server to check the passcode." });
    }
    setChecking(false);
  }

  async function suggest(i: number) {
    const r = rows[i];
    patch(i, { busy: true, msg: "" });
    try {
      const res = await fetch("/api/domains/expand", { method: "POST", headers: headers(), body: JSON.stringify({ name: r.name, intentNote: r.intentNote }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed");
      patch(i, {
        busy: false,
        catsText: j.arxivCats.join(", "),
        kwText: j.keywords.join(", "),
        exText: j.excludeKeywords.join(", "),
        msg: "Suggested by AI. Review and edit, then Save.",
      });
    } catch (e) {
      patch(i, { busy: false, msg: e instanceof Error ? e.message : "Failed" });
    }
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      sessionStorage.setItem("rp-admin", pass);
    } catch {}
    // a new row gets its id from the name the user finally typed, not a placeholder
    const taken: string[] = rows.filter((r) => !r.isNew).map((r) => r.id);
    const domains = rows.map((r) => ({
      id: r.isNew ? (() => { const id = slug(r.name, taken); taken.push(id); return id; })() : r.id,
      name: r.name.trim(),
      intentNote: r.intentNote.trim(),
      arxivCats: split(r.catsText),
      keywords: split(r.kwText),
      excludeKeywords: split(r.exText),
      maxPapers: Number(r.maxPapers),
      active: r.active,
    }));
    try {
      const res = await fetch("/api/domains", { method: "PUT", headers: headers(), body: JSON.stringify({ domains }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not save");
      setRows((rs) => rs.map((r, i) => ({ ...r, id: domains[i].id, isNew: false }))); // ids are now fixed
      setStatus({ kind: "ok", text: `Saved ${j.count} domains. The next Monday run will use them.` });
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not save" });
    }
    setSaving(false);
  }

  const add = () =>
    setRows((rs) => [
      ...rs,
      { id: slug("new domain", rs.map((r) => r.id)), name: "", intentNote: "", catsText: "", kwText: "", exText: "", maxPapers: 4, active: true, isNew: true },
    ]);

  if (!meta) return <p className="quiet">Loading…</p>;

  return (
    <div className="settings">
      {!meta.writable && (
        <div className="banner stale">Editing is disabled on this server (no admin passcode is configured).</div>
      )}
      {meta.source === "default" && <div className="banner sample">Showing the built-in starter domains. Saving creates your own list.</div>}

      {meta.needsPasscode && (
        <div className={`card unlock ${unlocked ? "is-unlocked" : ""}`}>
          <label className="field" htmlFor="admin-pass">
            Admin passcode
          </label>
          <div className="pass-row">
            <input
              id="admin-pass"
              type={showPass ? "text" : "password"}
              value={pass}
              onChange={(e) => {
                setPass(e.target.value);
                setUnlocked(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && unlock()}
              placeholder="Paste the ADMIN_PASSCODE value"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="btn" onClick={() => setShowPass((s) => !s)} aria-pressed={showPass}>
              {showPass ? "Hide" : "Show"}
            </button>
            <button type="button" className="btn primary" onClick={() => unlock()} disabled={checking || !pass.trim() || unlocked}>
              {checking ? "Checking…" : unlocked ? "Unlocked ✓" : "Unlock"}
            </button>
          </div>
          <p className="hint">It is the value after <code>ADMIN_PASSCODE=</code> in your <code>.env.local</code> file, the same one saved in Vercel.</p>
          {passMsg && <p className={`pass-msg ${passMsg.kind}`}>{passMsg.text}</p>}
        </div>
      )}

      {rows.map((r, i) => (
        <article className={`card dom ${r.active ? "" : "off"}`} key={r.id}>
          <div className="dom-head">
            <label className="field grow">
              Domain name
              <input value={r.name} onChange={(e) => patch(i, { name: e.target.value })} maxLength={80} placeholder="e.g. AI agents" />
            </label>
            <label className="check">
              <input type="checkbox" checked={r.active} onChange={(e) => patch(i, { active: e.target.checked })} /> Active
            </label>
          </div>
          <label className="field">
            What matters to you in this domain (optional)
            <input value={r.intentNote} onChange={(e) => patch(i, { intentNote: e.target.value })} maxLength={400} placeholder="e.g. Reliability and real deployment, not toy demos" />
          </label>
          <button type="button" className="btn" disabled={r.busy || r.name.trim().length < 2 || (meta.needsPasscode && !unlocked)} onClick={() => suggest(i)}>
            {r.busy ? "Thinking…" : "Suggest search terms with AI"}
          </button>
          {r.msg && <p className="meta">{r.msg}</p>}
          <label className="field">
            Search phrases (comma separated)
            <textarea rows={2} value={r.kwText} onChange={(e) => patch(i, { kwText: e.target.value })} />
          </label>
          <div className="two">
            <label className="field">
              arXiv categories
              <input value={r.catsText} onChange={(e) => patch(i, { catsText: e.target.value })} placeholder="cs.AI, cs.CL" />
            </label>
            <label className="field">
              Exclude phrases
              <input value={r.exText} onChange={(e) => patch(i, { exText: e.target.value })} placeholder="image retrieval" />
            </label>
            <label className="field narrow">
              Max papers
              <input type="number" min={1} max={6} value={r.maxPapers} onChange={(e) => patch(i, { maxPapers: Number(e.target.value) })} />
            </label>
          </div>
          <button type="button" className="link-btn" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
            Remove this domain
          </button>
        </article>
      ))}

      <div className="actions">
        <button type="button" className="btn" onClick={add} disabled={rows.length >= meta.max}>
          Add a domain {rows.length >= meta.max ? `(max ${meta.max})` : ""}
        </button>
        <button type="button" className="btn primary" onClick={save} disabled={saving || !meta.writable || (meta.needsPasscode && !unlocked)} title={meta.needsPasscode && !unlocked ? "Unlock with the admin passcode first" : undefined}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
      {status && <div className={`banner ${status.kind === "ok" ? "okmsg" : "stale"}`}>{status.text}</div>}
    </div>
  );
}
