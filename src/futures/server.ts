import type { FuturesEvent } from "./trader";
import type { ExecFill } from "./types";

interface Meta { model: string; exec: "sim" | "ibkr"; roots: string[]; startedAt: number }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/** GET / latest event per root · GET /history?root=MES · GET /events SSE (`snapshot`, `cycle`, `fill`, `ping`). Same shape as the Monad server. */
export function startFuturesServer(port: number, meta: Meta, history: () => FuturesEvent[]) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  const latest = () => {
    const out: Record<string, FuturesEvent> = {};
    for (const e of history()) out[e.root] = e;
    return out;
  };

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (url.pathname === "/") return json({ ...meta, latest: latest() });
      if (url.pathname === "/history") {
        const root = url.searchParams.get("root")?.toUpperCase();
        return json(root ? history().filter((e) => e.root === root) : history());
      }
      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, latest: latest() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcastCycle: (e: FuturesEvent) => broadcast("cycle", e),
    broadcastFill: (f: ExecFill) => broadcast("fill", f),
  };
}
