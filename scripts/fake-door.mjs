import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
export async function startFakeDoor({ dir }) {
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  writeFileSync(path.join(dir, "token"), token);
  const socket = path.join(dir, "modules.sock");
  rmSync(socket, { force: true });
  const state = { emailOn: true, filesOn: true, mail: [], files: new Map() };
  const seen = new Map();
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`)
      return reply(401, { error: "MODULE_TOKEN_INVALID" });
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = Buffer.concat(parts);
    if (req.url === "/v1/email" && req.method === "POST") {
      if (!state.emailOn) return reply(404, { error: "MODULE_OFF" });
      const key = req.headers["idempotency-key"];
      if (!key || key.length > 255) return reply(400, { error: "IDEMPOTENCY_KEY_REQUIRED" });
      if (!seen.has(key)) {
        state.mail.push({ ...JSON.parse(body.toString()), key });
        seen.set(key, true);
      }
      return reply(202, { accepted: true });
    }
    if (req.url.startsWith("/v1/files/")) {
      if (!state.filesOn) return reply(404, { error: "MODULE_OFF" });
      const key = decodeURIComponent(req.url.slice("/v1/files/".length));
      if (req.method === "PUT") {
        state.files.set(key, body);
        return reply(201, { stored: true });
      }
      if (req.method === "DELETE") {
        state.files.delete(key);
        return reply(200, { deleted: true });
      }
      if (req.method === "GET" && state.files.has(key)) {
        res.writeHead(200);
        return res.end(state.files.get(key));
      }
      return reply(404, { error: "FILE_NOT_FOUND" });
    }
    reply(404, { error: "MODULE_OFF" });
  });
  await new Promise((r) => server.listen(socket, r));
  return {
    ...state,
    get emailOn() {
      return state.emailOn;
    },
    set emailOn(v) {
      state.emailOn = v;
    },
    get filesOn() {
      return state.filesOn;
    },
    set filesOn(v) {
      state.filesOn = v;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
