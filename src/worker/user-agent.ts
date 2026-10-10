/**
 * Every request says who is asking and how to reach them, so a company that does not want to be polled can tell us.
 * The contact is yours to provide; nothing here invents one.
 */
export function buildUserAgent(contact: string | undefined): string {
  const value = (contact ?? "").trim();
  if (value === "") {
    throw new Error(
      "HR_CONTACT is empty. Put an email address or a URL where a company can reach you in .env (see .env.example). " +
        "It goes into the User-Agent header of every request.",
    );
  }
  // Header values cannot hold control characters, and a closing bracket would end the User-Agent comment early.
  const hasControlCharacter = [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (value.length > 200 || hasControlCharacter || /[()]/.test(value)) {
    throw new Error("HR_CONTACT must be one line of at most 200 characters, without parentheses.");
  }
  return `Sooner/0.1 (+${value})`;
}
