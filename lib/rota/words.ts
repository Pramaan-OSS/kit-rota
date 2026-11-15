// Input checks shared by the portal's routes, each failing with words a person can act on.
import { AccountError } from "../accounts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function text(value: unknown, what: string, max: number) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v.length > max)
    throw new AccountError(400, `Enter ${what} of up to ${max} characters.`);
  return v;
}

export function email(value: unknown) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v.length > 254 || !EMAIL.test(v)) throw new AccountError(400, "Enter a valid email address.");
  return v;
}

/** A row id from the browser. A malformed one reads as not found, the same as a row outside the viewer's scope. */
export function id(value: unknown, what = "That item") {
  if (typeof value !== "string" || !UUID.test(value))
    throw new AccountError(404, `${what} couldn't be found.`);
  return value;
}

export const notFound = (what: string) => new AccountError(404, `${what} couldn't be found.`);

/** One CSV cell, quoted, with a leading formula character defused so a spreadsheet never runs it. */
export function csvCell(value: string) {
  return `"${(/^[\s]*[=+@-]/u.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;
}
