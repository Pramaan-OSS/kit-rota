"use client";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/pramaan/client";
import { siteName } from "./site";

export type User = { id: string; email: string | null; role: string };

/** The page frame: the business's name and the links this person's role can use. */
export function Shell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    api<{ user: User }>("/api/account/session").then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);
  return (
    <>
      <header className="border-b bg-white">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-5 p-5">
          <Link href="/">{siteName}</Link>

          {user && <Link href="/rota">Rota</Link>}
          {user && <Link href="/availability">Availability</Link>}
          {user && user.role !== "staff" && <Link href="/team">Team</Link>}
          {user?.role === "owner" && <Link href="/settings">Settings</Link>}
          {user?.role === "owner" && <Link href="/owner">Owner settings</Link>}
        </nav>
      </header>
      {children}
    </>
  );
}
