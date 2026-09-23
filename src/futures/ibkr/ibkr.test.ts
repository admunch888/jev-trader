import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ConnectionState, EventName, IBApiTickType as Tick, OrderStatus, type IBApi, type IBApiNext } from "@stoqey/ib";
import { frontContract } from "../contracts";
import type { ExecFill, OrderUpdate } from "../types";
import { IbkrExecution } from "./execution";
import { explain, IbkrMarketData } from "./marketData";

const MES = { ...frontContract("MES", new Date("2026-09-22T14:00:00Z")), brokerId: 815824257 }; // MESZ6
const waitFor = async (ok: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await Bun.sleep(5); }
};

// ---------------------------------------------------------------------------------------------------------
// Market data: a fake IBApiNext whose streams the test feeds or fails.
// ---------------------------------------------------------------------------------------------------------

type Obs = { next?: (v: unknown) => void; error?: (e: unknown) => void };
class FakeStream {
  subs = new Set<Obs>();
  subscribe(o: Obs) { this.subs.add(o); return { unsubscribe: () => { this.subs.delete(o); } }; }
  emit(v: unknown) { this.subs.forEach((o) => o.next?.(v)); }
  fail(e: unknown) { const s = [...this.subs]; this.subs.clear(); s.forEach((o) => o.error?.(e)); }
}
class FakeNext {
  quotes: FakeStream[] = [];
  prints: FakeStream[] = [];
  connectionState = { subscribe: (cb: (s: ConnectionState) => void) => { cb(ConnectionState.Connected); return { unsubscribe() {} }; } };
  error = { subscribe: () => ({ unsubscribe() {} }) };
  connect() {}
  disconnect() {}
  setMarketDataType() {}
  getMarketData() { const s = new FakeStream(); this.quotes.push(s); return s; }
  getTickByTickAllLastDataUpdates() { const s = new FakeStream(); this.prints.push(s); return s; }
  getMarketDepth() { return new FakeStream(); }
}
const ticks = (bid: number, ask: number, delayed = false) => ({
  all: new Map(delayed
    ? [[Tick.DELAYED_BID, { value: bid }], [Tick.DELAYED_ASK, { value: ask }]]
    : [[Tick.BID, { value: bid }], [Tick.ASK, { value: ask }], [Tick.BID_SIZE, { value: 5 }], [Tick.ASK_SIZE, { value: 7 }]]),
});
const NOT_SUBSCRIBED = { code: 354, error: new Error("Requested market data is not subscribed. Delayed market data is available.") };

async function mdSetup() {
  const api = new FakeNext();
  const logs: string[] = [];
  const md = new IbkrMarketData({ api: api as unknown as IBApiNext, retrySeconds: 0.02, log: (m) => logs.push(m) });
  await md.connect();
  await md.subscribe(MES);
  return { api, md, logs };
}

describe("IbkrMarketData without a data subscription", () => {
  test("explains once, clears the book, retries, and picks the data up when it arrives", async () => {
    const { api, md, logs } = await mdSetup();
    api.quotes[0]!.emit(ticks(5700, 5700.25));
    expect(md.book(MES)).toMatchObject({ bid: 5700, ask: 5700.25, delayed: false });

    api.quotes[0]!.fail(NOT_SUBSCRIBED);
    expect(md.book(MES)).toBeNull(); // never trade on the last quote
    expect(md.health(MES)).toEqual({ quotes: "none", prints: "live", reason: "no real-time CME data (354)" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Client Portal");
    expect(logs[0]).toContain("IB_MARKET_DATA_TYPE=3");

    await waitFor(() => api.quotes.length === 2); // retried
    api.quotes[1]!.fail(NOT_SUBSCRIBED);
    expect(logs).toHaveLength(1); // same reason: not repeated

    await waitFor(() => api.quotes.length === 3);
    api.quotes[2]!.emit(ticks(5701, 5701.25, true));
    expect(md.health(MES)).toMatchObject({ quotes: "delayed", reason: null });
    expect(logs.at(-1)).toContain("flowing again (delayed)");
    api.quotes[2]!.emit(ticks(5701.25, 5701.5));
    expect(md.book(MES)!.delayed).toBe(false); // delayed is not sticky
  });

  test("missing tick-by-tick trades do not stop quotes", async () => {
    const { api, md, logs } = await mdSetup();
    api.quotes[0]!.emit(ticks(5700, 5700.25));
    api.prints[0]!.fail({ code: 10189, error: new Error("Failed to request tick-by-tick data.No market data permissions for CME FUT") });
    expect(md.health(MES)).toEqual({ quotes: "live", prints: "none", reason: "no tick-by-tick trades (10189)" });
    expect(md.book(MES)).not.toBeNull();
    expect(logs[0]).toContain("Trading continues");
  });

  test("unsubscribing stops the retries", async () => {
    const { api, md } = await mdSetup();
    api.quotes[0]!.fail(NOT_SUBSCRIBED);
    md.unsubscribe(MES);
    await Bun.sleep(60);
    expect(api.quotes).toHaveLength(1);
  });

  test("a competing live session is named as such", () => {
    expect(explain("quotes", MES, { code: 10197, error: new Error("No market data during competing live session") }).explain).toContain("Log out there");
  });
});

// ---------------------------------------------------------------------------------------------------------
// Execution: a fake IBApi socket per connection attempt.
// ---------------------------------------------------------------------------------------------------------

class FakeIB extends EventEmitter {
  static made: FakeIB[] = [];
  static refuse = 0;
  calls: string[] = [];
  placed: { id: number; order: { orderRef?: string } }[] = [];
  constructor() { super(); FakeIB.made.push(this); }
  connect() {
    this.calls.push("connect");
    if (FakeIB.refuse > 0) { FakeIB.refuse--; return this; } // never answers: the attempt times out
    setTimeout(() => this.emit(EventName.nextValidId, 100), 1);
    return this;
  }
  disconnect() { this.calls.push("disconnect"); return this; }
  placeOrder(id: number, _c: unknown, order: { orderRef?: string }) { this.placed.push({ id, order }); return this; }
  cancelOrder(id: number) { this.calls.push(`cancel ${id}`); return this; }
  reqGlobalCancel() { this.calls.push("globalCancel"); return this; }
  reqOpenOrders() { this.calls.push("reqOpenOrders"); return this; }
  reqExecutions() { this.calls.push("reqExecutions"); return this; }
}

async function exSetup() {
  FakeIB.made = [];
  FakeIB.refuse = 0;
  const logs: string[] = [];
  const ex = new IbkrExecution({ createApi: () => new FakeIB() as unknown as IBApi, reconnectMs: 10, maxReconnectMs: 40, connectTimeoutMs: 60, log: (m) => logs.push(m) });
  await ex.connect();
  const fills: ExecFill[] = [], updates: OrderUpdate[] = [];
  ex.onFill((f) => fills.push(f));
  ex.onOrder((u) => updates.push(u));
  return { ex, logs, fills, updates };
}
const stop = { ref: "MES-s1", contract: MES, side: "sell" as const, qty: 1, kind: "stop" as const, price: 5696.25, tif: "gtc" as const };
const ibMES = { symbol: "MES", secType: "FUT", lastTradeDateOrContractMonth: "20261218" };

describe("IbkrExecution reconnect", () => {
  test("refuses orders while down, reconnects, and replays what it missed exactly once", async () => {
    const { ex, logs, fills, updates } = await exSetup();
    expect(ex.status).toBe("connected");
    await ex.place(stop);
    expect(FakeIB.made[0]!.placed[0]).toMatchObject({ id: 100, order: { orderRef: "MES-s1" } });

    FakeIB.made[0]!.emit(EventName.disconnected); // Gateway restart
    expect(ex.status).toBe("reconnecting");
    await expect(ex.place({ ...stop, ref: "MES-s2" })).rejects.toThrow("reconnecting");
    expect(logs[0]).toContain("Protective stops stay working");

    await waitFor(() => ex.status === "connected");
    const s2 = FakeIB.made[1]!;
    expect(s2.calls).toEqual(["connect", "reqOpenOrders", "reqExecutions"]);

    // The stop filled while we were away: IBKR replays its status and the execution on the new socket.
    s2.emit(EventName.orderStatus, 100, OrderStatus.Filled, 1, 0, 5696.25);
    expect(updates.at(-1)).toMatchObject({ ref: "MES-s1", state: "filled", filled: 1 });
    const exec = { execId: "e1", orderId: 100, orderRef: "MES-s1", side: "SLD", shares: 1, price: 5696.25 };
    s2.emit(EventName.execDetails, -1, ibMES, exec);
    s2.emit(EventName.commissionReport, { execId: "e1", commission: 0.62 });
    s2.emit(EventName.execDetails, -1, ibMES, exec); // replayed again: ignored
    expect(fills).toEqual([expect.objectContaining({ ref: "MES-s1", execId: "e1", contract: "MESZ6", side: "sell", qty: 1, commission: 0.62 })]);
  });

  test("backs off while the Gateway is not answering", async () => {
    const { ex, logs } = await exSetup();
    FakeIB.refuse = 2;
    FakeIB.made[0]!.emit(EventName.disconnected);
    await waitFor(() => ex.status === "connected", 3000);
    expect(FakeIB.made).toHaveLength(4); // first socket + 2 refused + 1 good
    expect(logs.some((l) => l.includes("attempt 1 failed"))).toBe(true);
    expect(logs.some((l) => l.includes("reconnected after 3 attempt(s)"))).toBe(true);
  });

  test("IBKR link loss pauses orders on the same socket until it is restored", async () => {
    const { ex } = await exSetup();
    const s = FakeIB.made[0]!;
    s.emit(EventName.error, new Error("Connectivity between IB and TWS has been lost."), 1100, -1);
    expect(ex.status).toBe("reconnecting");
    await expect(ex.place(stop)).rejects.toThrow();
    s.emit(EventName.error, new Error("Connectivity between IB and TWS has been restored - data maintained."), 1102, -1);
    expect(ex.status).toBe("connected");
    expect(FakeIB.made).toHaveLength(1);
    expect(s.calls).toContain("reqExecutions");
  });

  test("close() does not reconnect", async () => {
    const { ex } = await exSetup();
    await ex.close();
    FakeIB.made[0]!.emit(EventName.disconnected);
    await Bun.sleep(50);
    expect(FakeIB.made).toHaveLength(1);
    expect(ex.status).toBe("disconnected");
  });
});
