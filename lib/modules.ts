// The one server-side client for platform email.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import type { Mailer } from "./email";

const dir = () => process.env.PRAMAAN_MODULES_DIR ?? "/pramaan-modules";
export const emailDoor: Mailer = {
  send(message, key) {
    return new Promise((resolve) => {
      let token: string;
      try {
        token = readFileSync(path.join(dir(), "token"), "utf8").trim();
      } catch {
        resolve({ status: "not-sent" });
        return;
      }
      const body = JSON.stringify(message);
      const sent = request(
        {
          socketPath: path.join(dir(), "modules.sock"),
          method: "POST",
          path: "/v1/email",
          timeout: 70_000,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "idempotency-key": key,
          },
        },
        (response) => {
          response.resume();
          const code = response.statusCode ?? 0;
          resolve({
            status:
              code === 200 || code === 202
                ? "sent"
                : [409, 502, 504].includes(code)
                  ? "unknown"
                  : "not-sent",
          });
        },
      );
      sent.on("timeout", () => sent.destroy(new Error("timeout")));
      // Never reached: nothing went. Reached and no answer: it may have gone.
      sent.on("error", (error: { code?: string }) =>
        resolve({
          status: error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "not-sent" : "unknown",
        }),
      );
      sent.end(body);
    });
  },
};
