import { randomUUID } from "node:crypto";
import { AccountError, type User } from "../accounts";
import { accountRuntime, database } from "../runtime";
export type Viewer = { user: User; workspaceId: string; role: "owner" | "manager" | "staff" };
export async function workspaceFor(user: User): Promise<Viewer> {
  if (user.role === "owner") {
    const c = await database().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
      const made = await c.query(
        "INSERT INTO workspaces(id,owner_id) VALUES($1,$2) ON CONFLICT(owner_id) DO NOTHING RETURNING id",
        [randomUUID(), user.id],
      );
      const wid =
        made.rows[0]?.id ??
        (await c.query("SELECT id FROM workspaces WHERE owner_id=$1", [user.id])).rows[0].id;
      await c.query("INSERT INTO workspace_members VALUES($1,$2,'owner') ON CONFLICT DO NOTHING", [
        wid,
        user.id,
      ]);
      if (made.rowCount) {
        await c.query(
          "INSERT INTO locations(workspace_id,name,timezone) VALUES($1,'Main location','Europe/London')",
          [wid],
        );
        await c.query(
          "INSERT INTO positions(workspace_id,name) VALUES($1,'Team member'),($1,'Supervisor')",
          [wid],
        );
        await c.query(
          "INSERT INTO shift_types(workspace_id,name) VALUES($1,'Regular'),($1,'Cover')",
          [wid],
        );
      }
      await c.query("COMMIT");
      return { user, workspaceId: wid, role: "owner" };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  const row = (
    await database().query("SELECT workspace_id,role FROM workspace_members WHERE user_id=$1", [
      user.id,
    ])
  ).rows[0];
  if (!row) throw new AccountError(403, "This account has no rota access.");
  return { user, workspaceId: row.workspace_id, role: row.role };
}
export async function viewer(r: Request) {
  return workspaceFor(await accountRuntime().requireUser(r));
}
export function manager(v: Viewer) {
  if (v.role === "staff") throw new AccountError(403, "Only a manager can change the rota.");
}
export function owner(v: Viewer) {
  if (v.role !== "owner") throw new AccountError(403, "Only the owner can do this.");
}
export async function self(v: Viewer) {
  const s = (
    await database().query("SELECT id FROM staff WHERE workspace_id=$1 AND user_id=$2", [
      v.workspaceId,
      v.user.id,
    ])
  ).rows[0];
  if (!s) throw new AccountError(403, "You need a staff record for this action.");
  return s.id as string;
}
