import { AccountError } from "../accounts";
export function parseCsv(source: string): string[][] {
  if (Buffer.byteLength(source) > 12000)
    throw new AccountError(413, "Import at most 12 KB at once.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
      continue;
    }
    if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (ch !== ",") {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
      }
      continue;
    }
    if (ch === '"' && cell === "" && !closed) {
      quoted = true;
      continue;
    }
    if (closed || ch === '"') throw new AccountError(400, "Check the CSV quotes.");
    cell += ch;
  }
  if (quoted) throw new AccountError(400, "Close the CSV quotes.");
  if (cell || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

import { manager, type Viewer } from "./access";
import { transaction } from "./data";
import { email, text } from "./words";
export async function importStaff(v: Viewer, value: unknown) {
  manager(v);
  if (typeof value !== "string") throw new AccountError(400, "Choose a CSV file.");
  const rows = parseCsv(value.replace(/^\uFEFF/u, ""));
  if (JSON.stringify(rows.shift()) !== JSON.stringify(["Name", "Email"]))
    throw new AccountError(400, "Use the CSV columns Name,Email.");
  if (!rows.length || rows.length > 100)
    throw new AccountError(400, "Import 1 to 100 staff at once.");
  return transaction(v, async (c) => {
    for (const row of rows) {
      if (row.length !== 2) throw new AccountError(400, "Use two columns for every staff row.");
      await c.query("INSERT INTO staff(workspace_id,name,email) VALUES($1,$2,$3)", [
        v.workspaceId,
        text(row[0], "a name", 120),
        email(row[1]),
      ]);
    }
    return { notice: `Imported ${rows.length} staff. Invite each person to let them sign in.` };
  });
}
