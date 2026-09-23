import { frontContract } from "../contracts";
import { ManualMarketData } from "../sim";
import type { Bar, BarSize, FuturesContract, Root } from "../types";
import { contractFromMeta, readTickFile, type DayFile, type MetaRecord, type TickRecord } from "./format";

/**
 * `MarketData` fed from recorded ticks. `apply` pushes one record; quotes become book snapshots stamped with the
 * record time, prints get an aggressor side inferred from the quote in force (as `IbkrMarketData` does live),
 * and one-minute bars of the mid build up so `bars()` answers with the history replayed so far.
 */
export class ReplayMarketData extends ManualMarketData {
  private minute = new Map<string, Bar[]>();

  constructor(private pick: (root: Root, at: Date) => FuturesContract) { super(); }

  override async resolve(root: Root, at = new Date()) { return this.pick(root, at); }

  override async bars(c: FuturesContract, _size: BarSize, _lookback: string): Promise<Bar[]> {
    return (this.minute.get(c.code) ?? []).slice(-120);
  }

  apply(c: FuturesContract, r: TickRecord) {
    if (r.k === "q") {
      this.setQuote(c, r.b, r.a, { bidSize: r.bs, askSize: r.as, ts: r.t });
      this.bar(c.code, r.t, (r.b + r.a) / 2);
    } else {
      const b = this.book(c);
      const side = !b ? null : r.p >= b.ask ? "buy" : r.p <= b.bid ? "sell" : null;
      this.print(c, { ts: r.t, price: r.p, size: r.s, side });
    }
  }

  private bar(code: string, t: number, mid: number) {
    const bars = this.minute.get(code) ?? [];
    const start = Math.floor(t / 60_000) * 60_000;
    const last = bars.at(-1);
    if (last && last.ts === start) {
      last.high = Math.max(last.high, mid);
      last.low = Math.min(last.low, mid);
      last.close = mid;
    } else {
      bars.push({ ts: start, open: mid, high: mid, low: mid, close: mid, volume: 0 });
      if (bars.length > 240) bars.shift();
    }
    this.minute.set(code, bars);
  }
}

export interface ReplayItem { root: Root; contract: FuturesContract; rec: TickRecord }

/** One contract's day files in order, as a single stream. Checks each file's meta matches where it was found. */
async function* contractStream(files: DayFile[]): AsyncGenerator<ReplayItem> {
  let contract: FuturesContract | null = null;
  for (const f of files) {
    for await (const r of readTickFile(f.path)) {
      if (r.k === "meta") {
        const m = r as MetaRecord;
        if (m.root !== f.root || m.code !== f.code) throw new Error(`${f.path}: meta says ${m.root}/${m.code}`);
        contract ??= contractFromMeta(m);
        continue;
      }
      yield { root: f.root, contract: contract!, rec: r as TickRecord };
    }
  }
}

/** Every contract's stream merged by time. Ties keep file order within a contract and stream order across them. */
export async function* mergeStreams(files: DayFile[]): AsyncGenerator<ReplayItem> {
  const byContract = new Map<string, DayFile[]>();
  for (const f of files) byContract.set(f.code, [...(byContract.get(f.code) ?? []), f]);
  const streams = [...byContract.values()].map((fs) => contractStream(fs));
  const heads: (ReplayItem | null)[] = await Promise.all(streams.map(async (s) => (await s.next()).value ?? null));
  for (;;) {
    let i = -1;
    for (let j = 0; j < heads.length; j++) if (heads[j] && (i < 0 || heads[j]!.rec.t < heads[i]!.rec.t)) i = j;
    if (i < 0) return;
    yield heads[i]!;
    heads[i] = (await streams[i]!.next()).value ?? null;
  }
}

/**
 * Which recorded contract to trade for `root` at `at`: the front contract by our roll calendar if it was recorded,
 * otherwise one recorded on that trading day (or the latest recorded one).
 */
export function contractPicker(files: DayFile[], tradingDay: (root: Root, at: Date) => string) {
  const contracts = new Map<string, FuturesContract>();
  return async function prime() {
    for (const f of files) {
      if (contracts.has(f.code)) continue;
      for await (const r of readTickFile(f.path)) { contracts.set(f.code, contractFromMeta(r as MetaRecord)); break; }
    }
    return (root: Root, at: Date): FuturesContract => {
      const front = frontContract(root, at);
      const day = tradingDay(root, at);
      const recorded = files.filter((f) => f.root === root);
      if (recorded.some((f) => f.code === front.code)) return contracts.get(front.code)!;
      const sameDay = recorded.filter((f) => f.day === day);
      const any = sameDay[0] ?? recorded.at(-1);
      if (!any) return front;
      return contracts.get(any.code)!;
    };
  };
}
