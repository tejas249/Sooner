/** The same server and credentials, pointed at another database. */
export function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${encodeURIComponent(database)}`;
  return next.toString();
}
