"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ApiError, type PublicForm } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { FormRenderer } from "../../../components/forms/FormRenderer";

function parseErrorBody(err: unknown): { message?: string; errors?: Record<string, string> } {
  if (!(err instanceof ApiError)) return {};
  try {
    return JSON.parse(err.message) as { message?: string; errors?: Record<string, string> };
  } catch {
    return {};
  }
}

/**
 * Public, unauthenticated hosted form. Also the iframe target for embeds
 * (`?embed=1` drops the page chrome and reports its height to the parent).
 */
export default function PublicFormPage() {
  const { token } = useParams<{ token: string }>();
  const embed = useSearchParams().get("embed") === "1";
  const [form, setForm] = useState<PublicForm | null>(null);
  const [missing, setMissing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.publicForms
      .get(token)
      .then((f) => {
        setForm(f);
        document.title = f.name;
      })
      .catch(() => setMissing(true));
  }, [token]);

  useEffect(() => {
    if (!embed || !rootRef.current || window.parent === window) return;
    const el = rootRef.current;
    const report = () => window.parent.postMessage({ type: "envoy-form:height", height: el.scrollHeight + 8 }, "*");
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [embed, form, missing]);

  return (
    <div ref={rootRef} className={embed ? "pf-embed" : "pf-page"}>
      <div className={embed ? undefined : "pf-card"}>
        {missing ? (
          <p className="ef-muted" role="status">
            This form isn&apos;t available.
          </p>
        ) : !form ? (
          <p className="ef-muted">Loading…</p>
        ) : (
          <>
            {!embed && <h1 className="pf-title">{form.name}</h1>}
            <FormRenderer
              schema={form.schema}
              accent={form.schema.accentColor}
              loadOptions={async (fieldKey, answers) => {
                try {
                  return await api.publicForms.options(token, fieldKey, answers);
                } catch (err) {
                  throw new Error(parseErrorBody(err).message ?? "Could not load options");
                }
              }}
              onSubmit={async (values) => {
                try {
                  const { successMessage } = await api.publicForms.submit(token, values);
                  return { ok: true, successMessage };
                } catch (err) {
                  const body = parseErrorBody(err);
                  if (err instanceof ApiError && err.status === 429) {
                    return { ok: false, message: "Too many attempts — please wait a minute and try again." };
                  }
                  return { ok: false, errors: body.errors, message: body.message ?? "Something went wrong. Please try again." };
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
