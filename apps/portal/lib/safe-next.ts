/** Where to go after signing in: `?next=` if it's a path on this site (never another site), else the dashboard. */
export function safeNext(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}
