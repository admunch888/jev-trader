import { EventName, IBApi, OrderAction, OrderStatus, OrderType, type CommissionReport, type Contract, type Execution as IbExecution, type Order, type OrderState as IbOrderState } from "@stoqey/ib";
import { onTick, SPECS } from "../contracts";
import type { AccountState, BrokerPosition, ExecFill, Execution, ExecStatus, OrderRequest, OrderState, OrderUpdate, Side, WhatIf } from "../types";
import { ibConfig, isPaperPort } from "./config";
import { codeOf, toIbContract, until } from "./contract";

interface Working { id: number; req: OrderRequest; contract: Contract; order: Order; state: OrderState }

/** IBKR messages that are information or warnings, not a rejection of the order they name. */
const INFO_CODES = new Set([399, 2104, 2106, 2107, 2108, 2109, 2119, 2158]);
const CANCELLED_CODE = 202;
/** How long to wait for an execution's commission report before emitting the fill without it. */
const COMMISSION_WAIT_MS = 2_000;
/** IBKR connectivity codes: 1100 the Gateway lost IBKR's servers; 1101 / 1102 it is back (1101: subscriptions lost). */
const LINK_LOST = 1100, LINK_BACK = new Set([1101, 1102]);

export interface IbkrExecutionOptions {
  /** Test seam: builds the IBApi socket; called again for every reconnect. */
  createApi?: () => IBApi;
  reconnectMs?: number;
  maxReconnectMs?: number;
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * IBKR order routing over TWS / IB Gateway, via the plain IBApi event emitter (the order callbacks map
 * one-to-one onto this interface). Connects as `IB_CLIENT_ID + 1` so it can run beside `IbkrMarketData`.
 *
 * Refuses a live port unless IB_LIVE=true. Order ids come from nextValidId and are never reused; our `ref`
 * rides along as IBKR's `orderRef`, so fills from a previous session can still be attributed.
 *
 * Reconnects by itself. When the Gateway socket drops (its daily restart, a crash), `status` leaves "connected"
 * and every call that would reach IBKR throws, so the trader counts a reject and holds. It retries on a fresh socket with a doubling wait (`reconnectMs` up to `maxReconnectMs`),
 * then re-requests open orders and today's executions: stops still working report their state again, and fills
 * that happened while it was away are emitted once (execution ids de-duplicate). Protective stops live at IBKR
 * and keep working throughout. If the socket stays up but the Gateway loses IBKR's servers (1100), orders pause
 * the same way until IBKR reports the link restored (1101 / 1102), then it resyncs on the same socket.
 */
export class IbkrExecution implements Execution {
  private api!: IBApi;
  private _status: ExecStatus = "disconnected";
  private closing = false;
  private reconnecting = false;
  private readonly log: (msg: string) => void;
  private nextId = -1;
  private byRef = new Map<string, Working>();
  private byId = new Map<number, Working>();
  private seenExec = new Set<string>();
  private pendingFills = new Map<string, { fill: ExecFill; timer: ReturnType<typeof setTimeout> }>();
  private orderCbs = new Set<(u: OrderUpdate) => void>();
  private fillCbs = new Set<(f: ExecFill) => void>();
  private reqSeq = 90_000; // request ids for account/positions/executions queries, clear of order ids

  constructor(private opts: IbkrExecutionOptions = {}) {
    this.log = opts.log ?? ((m) => console.warn(`ibkr exec: ${m}`));
  }

  get status() { return this._status; }

  async connect() {
    if (!isPaperPort(ibConfig.port) && !ibConfig.allowLive) {
      throw new Error(`IB_PORT ${ibConfig.port} is a live port; set IB_LIVE=true to trade real money`);
    }
    this.closing = false;
    await this.open();
  }

  async close() {
    this.closing = true;
    this._status = "disconnected";
    this.api?.disconnect();
  }

  /** A fresh socket with every listener wired; resolves once IBKR hands over the next order id. */
  private async open() {
    const api = this.opts.createApi?.() ?? new IBApi({ host: ibConfig.host, port: ibConfig.port });
    this.api = api;
    let ready = false;
    api.on(EventName.nextValidId, (id) => { this.nextId = Math.max(this.nextId, id); ready = true; });
    api.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => this.onStatus(id, status, filled, remaining, avgFillPrice));
    api.on(EventName.execDetails, (_req, contract, exec) => this.onExec(contract, exec));
    api.on(EventName.commissionReport, (r) => this.onCommission(r));
    api.on(EventName.error, (err, code, reqId) => this.onError(err, code, reqId));
    api.on(EventName.disconnected, () => { if (api === this.api) this.lost("the Gateway connection closed"); });
    this._status = this.reconnecting ? "reconnecting" : "connecting";
    api.connect(ibConfig.clientId + 1);
    try {
      await until(() => ready, this.opts.connectTimeoutMs ?? ibConfig.requestTimeoutMs, "IBKR execution connection");
    } catch (e) {
      api.removeAllListeners();
      api.disconnect();
      throw e;
    }
    this._status = "connected";
  }

  /** The Gateway socket dropped: stop accepting orders and start reconnecting (once). */
  private lost(why: string) {
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;
    this._status = "reconnecting";
    this.log(`${why}; orders are refused until it reconnects. Protective stops stay working at IBKR.`);
    void this.reconnectLoop();
  }

  private async reconnectLoop() {
    let wait = this.opts.reconnectMs ?? ibConfig.reconnectMs;
    const max = this.opts.maxReconnectMs ?? ibConfig.maxReconnectMs;
    let attempt = 0;
    while (!this.closing) {
      await Bun.sleep(wait);
      if (this.closing) break;
      attempt++;
      try {
        this.api.removeAllListeners();
        this.api.disconnect();
      } catch { /* already gone */ }
      try {
        await this.open();
        this.reconnecting = false;
        this.log(`reconnected after ${attempt} attempt(s); resyncing open orders and today's executions.`);
        this.resync();
        return;
      } catch (e) {
        this.log(`reconnect attempt ${attempt} failed (${(e as Error).message}); next in ${Math.round(Math.min(wait * 2, max) / 1000)}s.`);
        wait = Math.min(wait * 2, max);
      }
    }
    this.reconnecting = false;
  }

  /** Replay what may have been missed: open orders report their status again, executions come back as fills (de-duplicated). */
  private resync() {
    this.api.reqOpenOrders();
    this.api.reqExecutions(this.reqSeq++, { clientId: String(ibConfig.clientId + 1) });
  }

  private ensureConnected() {
    if (this._status !== "connected") throw new Error(`IBKR execution is ${this._status}; order not sent`);
  }

  async place(req: OrderRequest): Promise<number> {
    this.ensureConnected();
    this.validate(req);
    if (this.byRef.has(req.ref)) throw new Error(`duplicate order ref ${req.ref}`);
    const contract = toIbContract(req.contract);
    const parent = this.track(req, contract, this.buildOrder(req));
    if (!req.bracket) {
      this.api.placeOrder(parent.id, contract, parent.order);
      return parent.id;
    }
    // Bracket: parent and take-profit are held (transmit false) until the stop goes out; IBKR links the children as OCA.
    const exit: Side = req.side === "buy" ? "sell" : "buy";
    const tp = this.track({ ...req, ref: `${req.ref}:tp`, side: exit, kind: "limit", price: req.bracket.takeProfit, tif: "gtc", bracket: undefined }, contract);
    const sl = this.track({ ...req, ref: `${req.ref}:sl`, side: exit, kind: "stop", price: req.bracket.stopLoss, tif: "gtc", bracket: undefined }, contract);
    parent.order.transmit = false;
    tp.order.parentId = parent.id; tp.order.transmit = false;
    sl.order.parentId = parent.id; sl.order.transmit = true;
    for (const w of [parent, tp, sl]) this.api.placeOrder(w.id, contract, w.order);
    return parent.id;
  }

  async modify(ref: string, change: { price?: number; qty?: number }) {
    this.ensureConnected();
    const w = this.mustWorking(ref);
    const req = { ...w.req, price: change.price ?? w.req.price, qty: change.qty ?? w.req.qty };
    this.validate(req);
    w.req = req;
    w.order = { ...w.order, ...priceFields(req), totalQuantity: req.qty, transmit: true };
    this.api.placeOrder(w.id, w.contract, w.order); // same id = modify in place
  }

  async cancel(ref: string) {
    this.ensureConnected();
    this.api.cancelOrder(this.mustWorking(ref).id);
  }

  async cancelAll() {
    this.ensureConnected();
    this.api.reqGlobalCancel();
  }

  /** Sends the order with whatIf set: IBKR answers with margin and commission impact in openOrder and never routes it. */
  async whatIf(req: OrderRequest): Promise<WhatIf> {
    this.ensureConnected();
    this.validate(req);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`whatIf ${req.ref} timed out`)); }, ibConfig.requestTimeoutMs);
      const onOpen = (orderId: number, _c: Contract, _o: Order, s: IbOrderState) => {
        if (orderId !== id) return;
        off();
        resolve({ initMarginChange: num(s.initMarginChange), maintMarginChange: num(s.maintMarginChange), commission: finite(s.commission) });
      };
      const onErr = (err: Error, _code: number, reqId: number) => {
        if (reqId !== id) return;
        off();
        reject(err);
      };
      const off = () => { clearTimeout(timer); this.api.off(EventName.openOrder, onOpen); this.api.off(EventName.error, onErr); };
      this.api.on(EventName.openOrder, onOpen);
      this.api.on(EventName.error, onErr);
      this.api.placeOrder(id, toIbContract(req.contract), { ...this.buildOrder(req), whatIf: true });
    });
  }

  async positions(): Promise<BrokerPosition[]> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      const out: BrokerPosition[] = [];
      const timer = setTimeout(() => { off(); reject(new Error("positions timed out")); }, ibConfig.requestTimeoutMs);
      const onPos = (account: string, c: Contract, pos: number, avgCost?: number) => {
        if (ibConfig.account && account !== ibConfig.account) return;
        if (!pos || c.secType !== "FUT") return;
        const mult = Number(c.multiplier) || 1; // IBKR avgCost includes the multiplier
        out.push({ contract: codeOf(c), qty: pos, avgPrice: (avgCost ?? 0) / mult });
      };
      const onEnd = () => { off(); this.api.cancelPositions(); resolve(out); };
      const off = () => { clearTimeout(timer); this.api.off(EventName.position, onPos); this.api.off(EventName.positionEnd, onEnd); };
      this.api.on(EventName.position, onPos);
      this.api.on(EventName.positionEnd, onEnd);
      this.api.reqPositions();
    });
  }

  async account(): Promise<AccountState> {
    this.ensureConnected();
    const reqId = this.reqSeq++;
    const tags: Record<string, keyof AccountState> = {
      NetLiquidation: "netLiquidation", AvailableFunds: "availableFunds", InitMarginReq: "initMargin", MaintMarginReq: "maintMargin",
    };
    return new Promise((resolve, reject) => {
      const out: AccountState = { netLiquidation: 0, availableFunds: 0, initMargin: 0, maintMargin: 0 };
      const timer = setTimeout(() => { off(); reject(new Error("account summary timed out")); }, ibConfig.requestTimeoutMs);
      const onRow = (id: number, account: string, tag: string, value: string) => {
        if (id !== reqId || (ibConfig.account && account !== ibConfig.account)) return;
        const key = tags[tag];
        if (key) out[key] += Number(value);
      };
      const onEnd = (id: number) => { if (id !== reqId) return; off(); this.api.cancelAccountSummary(reqId); resolve(out); };
      const off = () => { clearTimeout(timer); this.api.off(EventName.accountSummary, onRow); this.api.off(EventName.accountSummaryEnd, onEnd); };
      this.api.on(EventName.accountSummary, onRow);
      this.api.on(EventName.accountSummaryEnd, onEnd);
      this.api.reqAccountSummary(reqId, "All", Object.keys(tags).join(","));
    });
  }

  onOrder(cb: (u: OrderUpdate) => void) { this.orderCbs.add(cb); return () => { this.orderCbs.delete(cb); }; }
  onFill(cb: (f: ExecFill) => void) { this.fillCbs.add(cb); return () => { this.fillCbs.delete(cb); }; }

  // ---------------------------------------------------------------------------------------------------------

  private validate(req: OrderRequest) {
    const spec = SPECS[req.contract.root];
    if (!Number.isInteger(req.qty) || req.qty <= 0) throw new Error(`${req.ref}: qty must be a positive integer, got ${req.qty}`);
    if (req.kind !== "market" && (req.price === undefined || !onTick(spec, req.price))) {
      throw new Error(`${req.ref}: ${req.kind} price ${req.price} is not on the ${spec.tickSize} tick grid`);
    }
    if (req.bracket && (!onTick(spec, req.bracket.takeProfit) || !onTick(spec, req.bracket.stopLoss))) {
      throw new Error(`${req.ref}: bracket prices must be on the tick grid`);
    }
  }

  private buildOrder(req: OrderRequest): Order {
    return {
      action: req.side === "buy" ? OrderAction.BUY : OrderAction.SELL,
      totalQuantity: req.qty,
      ...priceFields(req),
      tif: req.tif === "gtc" ? "GTC" : req.tif === "ioc" ? "IOC" : "DAY",
      orderRef: req.ref,
      transmit: true,
      ...(ibConfig.account ? { account: ibConfig.account } : {}),
    };
  }

  private track(req: OrderRequest, contract: Contract, order = this.buildOrder(req)): Working {
    const w: Working = { id: this.nextId++, req, contract, order, state: "pending" };
    this.byRef.set(req.ref, w);
    this.byId.set(w.id, w);
    return w;
  }

  private mustWorking(ref: string) {
    const w = this.byRef.get(ref);
    if (!w) throw new Error(`unknown order ref ${ref}`);
    if (w.state === "filled" || w.state === "cancelled" || w.state === "rejected") throw new Error(`order ${ref} is already ${w.state}`);
    return w;
  }

  private onStatus(id: number, status: OrderStatus, filled: number, remaining: number, avgFillPrice: number) {
    const w = this.byId.get(id);
    if (!w) return;
    const state = mapStatus(status, filled, w.state);
    w.state = state;
    this.emitOrder({ ref: w.req.ref, brokerId: id, state, filled, remaining, avgPrice: filled ? avgFillPrice : null, ts: Date.now() });
  }

  private onError(err: Error, code: number, reqId: number) {
    if (code === LINK_LOST) {
      // The socket to the Gateway is fine; the Gateway lost IBKR's servers. Pause orders until 1101 / 1102 says it is back.
      if (this._status === "connected") {
        this._status = "reconnecting";
        this.log(`the Gateway lost its connection to IBKR (${code}); orders are refused until it is restored. Protective stops stay working at IBKR.`);
      }
      return;
    }
    if (LINK_BACK.has(code) && this._status === "reconnecting" && !this.reconnecting) {
      this._status = "connected";
      this.log(`IBKR connectivity restored (${code}); resyncing.`);
      return this.resync();
    }
    const w = this.byId.get(reqId);
    if (!w) {
      if (!INFO_CODES.has(code)) console.warn(`ibkr exec: ${code} ${err.message}`);
      return;
    }
    if (INFO_CODES.has(code)) return;
    w.state = code === CANCELLED_CODE ? "cancelled" : "rejected";
    this.emitOrder({ ref: w.req.ref, brokerId: reqId, state: w.state, filled: 0, remaining: w.req.qty, avgPrice: null, reason: `${code} ${err.message}`, ts: Date.now() });
  }

  /** Executions arrive first, their commission in a separate message; hold each fill briefly so it goes out with its fee. */
  private onExec(contract: Contract, e: IbExecution) {
    if (!e.execId || this.seenExec.has(e.execId)) return;
    this.seenExec.add(e.execId);
    const fill: ExecFill = {
      ref: e.orderRef ?? this.byId.get(e.orderId ?? -1)?.req.ref ?? "",
      execId: e.execId,
      contract: codeOf(contract),
      side: e.side === "BOT" ? "buy" : "sell",
      qty: e.shares ?? 0,
      price: e.price ?? 0,
      ts: Date.now(),
      commission: null,
    };
    const timer = setTimeout(() => this.flushFill(fill.execId), COMMISSION_WAIT_MS);
    this.pendingFills.set(fill.execId, { fill, timer });
  }

  private onCommission(r: CommissionReport) {
    const p = r.execId ? this.pendingFills.get(r.execId) : undefined;
    if (!p) return;
    p.fill.commission = finite(r.commission);
    clearTimeout(p.timer);
    this.flushFill(p.fill.execId);
  }

  private flushFill(execId: string) {
    const p = this.pendingFills.get(execId);
    if (!p) return;
    this.pendingFills.delete(execId);
    this.fillCbs.forEach((cb) => cb(p.fill));
  }

  private emitOrder(u: OrderUpdate) {
    this.orderCbs.forEach((cb) => cb(u));
  }
}

function priceFields(req: OrderRequest): Pick<Order, "orderType" | "lmtPrice" | "auxPrice"> {
  if (req.kind === "limit") return { orderType: OrderType.LMT, lmtPrice: req.price };
  if (req.kind === "stop") return { orderType: OrderType.STP, auxPrice: req.price };
  return { orderType: OrderType.MKT };
}

function mapStatus(s: OrderStatus, filled: number, prev: OrderState): OrderState {
  switch (s) {
    case OrderStatus.Filled: return "filled";
    case OrderStatus.Cancelled:
    case OrderStatus.ApiCancelled: return "cancelled";
    case OrderStatus.Inactive: return "rejected";
    case OrderStatus.PreSubmitted:
    case OrderStatus.Submitted: return filled > 0 ? "partial" : "working";
    case OrderStatus.PendingCancel: return prev;
    default: return "pending";
  }
}

/** IBKR sends Double.MAX_VALUE for "not set". */
const finite = (x: number | undefined) => (x !== undefined && Number.isFinite(x) && Math.abs(x) < 1e300 ? x : null);
const num = (x: number | string | undefined) => finite(Number(x)) ?? 0;
