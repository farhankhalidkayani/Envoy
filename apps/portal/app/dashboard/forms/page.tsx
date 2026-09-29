"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, type Form } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toast";

export default function FormsPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [forms, setForms] = useState<Form[] | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    api.forms
      .list()
      .then(setForms)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setNotEnabled(true);
        else setError(errorMessage(err));
      });
  }
  useEffect(load, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const form = await api.forms.create(name.trim() || "Untitled form");
      router.push(`/dashboard/forms/${form.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.forms.remove(deleting.id);
      showToast("Form deleted.");
      setDeleting(null);
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (notEnabled) {
    return (
      <div>
        <h1 className="page-title">Lead forms</h1>
        <div className="card" style={{ color: "var(--ink-faint)" }}>
          Lead forms aren&apos;t enabled for your account yet. Ask your workspace admin to turn them on.
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title">Lead forms</h1>
      {error && <div className="error-banner">{error}</div>}

      <form className="card" onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          aria-label="New form name"
          placeholder="New form name, e.g. Property enquiry"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-primary" disabled={creating} style={{ whiteSpace: "nowrap" }}>
          {creating ? "Creating…" : "+ New form"}
        </button>
      </form>

      {forms === null ? null : forms.length === 0 ? (
        <div className="card" style={{ color: "var(--ink-faint)" }}>
          No forms yet. Create one to build multi-step, conditional lead forms whose answers flow to your CRM and
          integrations.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Submissions</th>
                <th>Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td>
                    <Link href={`/dashboard/forms/${f.id}`}>{f.name}</Link>
                  </td>
                  <td>
                    <span className={`pill ${f.status === "live" ? "pill-ok" : "pill-gray"}`}>{f.status}</span>
                  </td>
                  <td>{f._count?.submissions ?? 0}</td>
                  <td>{new Date(f.updatedAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={() => setDeleting(f)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name}”?`}
        description="The form, its public link, and all of its submissions will be permanently deleted. Data already pushed to your CRM or integrations is not affected."
        confirmLabel="Delete form"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
