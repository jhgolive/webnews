/**
 * server.js
 * - Express server serves static files from /public
 * - /proxy?url=ENCODED_URL  -> fetches target and returns HTML with headers removed and <base> injected
 * - WebSocket server (ws) attached to same HTTP server
 *   - clients connect with query: ?type=viewer&room=room1  OR  ?type=controller&room=room1
 *   - controller 메시지는 해당 room의 viewer로 중계
 *
 * NOTE:
 * - Node >=18 환경이면 global fetch 사용 가능. 여기서는 node-fetch를 사용하도록 package.json에 추가했음.
 * - Railway 는 HTTPS를 제공하니 wss/ws URL은 자동으로 작동함.
 */

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { fetch } from "undici";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Security basics
app.use(helmet({
  contentSecurityPolicy: false // we will handle CSP for proxied pages separately
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve static viewer/controller
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Simple health check
app.get("/health", (req, res) => res.send({ status: "ok" }));

/**
 * Proxy endpoint
 * Example: /proxy?url=https%3A%2F%2Fwww.google.com
 *
 * - fetch target
 * - remove X-Frame-Options and Content-Security-Policy headers
 * - inject <base href="..."> into <head> to fix relative links
 */
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send("Missing 'url' query parameter.");
  }

  try {
    const targetUrl = new URL(target);

    const resp = await fetch(target, {
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0"
      },
      // 🔥 중요: undici는 compression 옵션으로 자동 압축 제거 가능
      // Node18 기본 fetch는 이게 안됨
      compress: false
    });

    // 🔥 모든 content-encoding 관련 헤더 제거
    res.removeHeader("content-encoding");

    const skip = [
      "x-frame-options",
      "content-security-policy",
      "content-security-policy-report-only",
      "strict-transport-security",
      "content-encoding",
      "cf-cache-status",
      "cf-ray",
      "etag",
      "vary"
    ];

    for (const [k, v] of resp.headers.entries()) {
      if (!skip.includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }

    const contentType =
      resp.headers.get("content-type") || "text/html; charset=utf-8";
    res.setHeader("Content-Type", contentType);

    let body = await resp.text();

    if (contentType.includes("text/html")) {
      const inject =
        `<base href="${targetUrl.origin}">\n` +
        `<meta name="proxied-from" content="${targetUrl.href}">\n`;

      body = body.replace(
        /<head([^>]*)>/i,
        (m) => `${m}\n${inject}`
      );
      res.send(body);
      return;
    }

    // binary fallback
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.send(buffer);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy fetch failed: " + String(err.message));
  }
});

// Create HTTP server and attach ws to same server
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/**
 * rooms = {
 *   roomId: {
 *     viewers: Set(ws),
 *     controllers: Set(ws)
 *   }
 * }
 */
const rooms = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { viewers: new Set(), controllers: new Set() });
  }
  return rooms.get(roomId);
}

server.on("upgrade", (request, socket, head) => {
  // accept all upgrades, let ws handle querystring
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  // parse query params
  const url = new URL(request.url, `http://${request.headers.host}`);
  const type = url.searchParams.get("type") || "controller";
  const roomId = url.searchParams.get("room") || "default";

  const room = ensureRoom(roomId);

  ws.meta = { type, roomId };

  if (type === "viewer") {
    room.viewers.add(ws);
    console.log(`Viewer joined room ${roomId} (viewers=${room.viewers.size})`);
  } else {
    room.controllers.add(ws);
    console.log(`Controller joined room ${roomId} (controllers=${room.controllers.size})`);
  }

  ws.on("message", (msgRaw) => {
    let msg;
    try {
      msg = typeof msgRaw === "string" ? msgRaw : msgRaw.toString();
    } catch (e) {
      msg = String(msgRaw);
    }

    // Simple protocol: controller -> viewer
    if (type === "controller") {
      // forward to all viewers in the room
      for (const v of room.viewers) {
        if (v.readyState === v.OPEN) {
          v.send(msg);
        }
      }
    } else if (type === "viewer") {
      // optionally viewer can send status messages to controllers
      for (const c of room.controllers) {
        if (c.readyState === c.OPEN) {
          c.send(JSON.stringify({ from: "viewer", payload: msg }));
        }
      }
    }
  });

  ws.on("close", () => {
    if (ws.meta.type === "viewer") {
      room.viewers.delete(ws);
      console.log(`Viewer left room ${roomId} (viewers=${room.viewers.size})`);
    } else {
      room.controllers.delete(ws);
      console.log(`Controller left room ${roomId} (controllers=${room.controllers.size})`);
    }
    // cleanup empty room
    if (room.viewers.size === 0 && room.controllers.size === 0) {
      rooms.delete(roomId);
    }
  });

  ws.on("error", (err) => {
    console.warn("WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Static files served from /public`);
});
