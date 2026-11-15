"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/pramaan/client";
import type { User } from "./shell";
import { siteName } from "./site";

const ROLE: Record<string, string> = {
  owner: "the owner",
  manager: "a manager",
  staff: "a staff member",
};

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ user: User }>("/api/account/session").then(
      (r) => setUser(r.user),
      () => {},
    );
  }, []);
  return (
    <main className="workspace">
      <p className="eyebrow">A clear week for everyone.</p>
      <h1>{siteName}</h1>
      {user ? (
        <section>
          <p>
            Signed in{user.email ? ` as ${user.email}` : ""},{" "}
            {ROLE[user.role] ?? "with no rota access"}.
          </p>
          <div className="links">
            <Link href="/rota">Rota</Link>
            <Link href="/availability">Availability</Link>
            {user.role === "owner" && <Link href="/team">Team</Link>}
            {user.role === "owner" && <Link href="/settings">Positions and shift types</Link>}
            {user.role === "owner" && <Link href="/owner">Owner settings</Link>}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/account/signout", {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-app-user": user.id },
                  body: "{}",
                });
                location.assign("/");
              } catch (e) {
                setMessage((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Sign out
          </button>
        </section>
      ) : (
        <section>
          <h2>Sign in</h2>
          <p>Accounts are made by invitation. Use the link in your invite email the first time.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              setMessage("");
              try {
                const r = await api<{ user: User }>("/api/account/signin", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ email: f.get("email"), password: f.get("password") }),
                });
                setUser(r.user);
                location.assign("/");
              } catch (e) {
                setMessage((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required maxLength={254} />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" disabled={busy}>
              Sign in
            </button>
          </form>
          <p>
            <Link href="/password-reset">Forgot your password?</Link>
          </p>
        </section>
      )}
      <p role="status">{message}</p>
    </main>
  );
}
