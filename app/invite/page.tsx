"use client";
import { useEffect, useState } from "react";
import { send } from "../parts";

/** Where an invite link lands. The token is in the address's fragment, so it never reaches a server log. */
export default function AcceptInvite() {
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<{ email: string; role: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = location.hash.slice(1);
    history.replaceState(null, "", "/invite");
    setToken(t);
    send<{ email: string; role: string }>("/api/invites", { action: "check", token: t }).then(
      setInvite,
      (e) => setMessage((e as Error).message),
    );
  }, []);
  return (
    <main className="workspace">
      <h1>Accept your invite</h1>
      {invite && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const password = String(f.get("password"));
            if (password !== f.get("confirm")) {
              setMessage("The two passwords don't match.");
              return;
            }
            setBusy(true);
            setMessage("");
            try {
              await send("/api/invites", { action: "accept", token, password });
              await send("/api/account/signin", { email: invite.email, password });
              location.assign("/");
            } catch (e) {
              setMessage((e as Error).message);
              setBusy(false);
            }
          }}
        >
          <p>
            You're joining as {invite.role === "manager" ? "a manager" : "a staff member"} with{" "}
            {invite.email}. Choose a password of at least 12 characters.
          </p>
          <label>
            Choose a password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
            />
          </label>
          <label>
            Type it again
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
            />
          </label>
          <button type="submit" disabled={busy}>
            Accept invite
          </button>
        </form>
      )}
      <p role="status">{message}</p>
    </main>
  );
}
