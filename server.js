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

    // fetch — Node18 기본 fetch 사용
    const resp = await fetch(target, {
      headers: {
        "User-Agent": req.headers["user-agent"] || 
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
      }
    });

    // 🚫 resp.headers.delete() 쓰면 immutable 에러 발생 → 절대 쓰면 안 됨
    // 대신 응답 헤더 복사 시 encoding 관련 헤더만 skip

    const headersToSkip = [
      "x-frame-options",
      "content-security-policy",
      "content-security-policy-report-only",
      "strict-transport-security",
      "content-encoding",      // gzip/br 제거용
      "transfer-encoding"      // chunked 같은 경우 충돌 방지
    ];

    // 모든 원본 헤더 복사 (skip 제외)
    resp.headers.forEach((value, key) => {
      if (!headersToSkip.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // content-type 보정
    const contentType = resp.headers.get("content-type") ||
      "text/html; charset=utf-8";
    res.setHeader("Content-Type", contentType);

    // 📌 body 읽기
    const body = await resp.text();  // Node18이 자동 압축해제

    // HTML 처리 — base injection
    if (contentType.includes("text/html")) {
      const injected = body.replace(
        /<head([^>]*)>/i,
        (m) => `${m}\n<base href="${targetUrl.origin}">\n`
      );
      return res.send(injected);
    }

    // 그 외 (이미 fetch가 압축 해제한 상태)
    const buffer = Buffer.from(await resp.arrayBuffer());
    return res.send(buffer);

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(502).send("Proxy fetch failed: " + err.message);
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
