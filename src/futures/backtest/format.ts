import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { contractFor, SPECS } from "../contracts";
import type { FuturesContract, Root } from "../types";

/**
 * Recorded market data, one JSON object per line, one file per contract per trading day:
 *
 *   <dir>/<ROOT>/<CODE>/<YYYY-MM-DD>.jsonl[.gz]      e.g. data/ticks/MES/MESZ6/2026-09-22.jsonl
 *
 *   {"k":"meta","v":1,"root":"MES","code":"MESZ6","month":"202612","source":"ibkr-live"}   first line
 *   {"k":"q","t":1790085600123,"b":5700,"a":5700.25,"bs":12,"as":9}                        quote: bid, ask, sizes
 *   {"k":"p","t":1790085600456,"p":5700.25,"s":2}                                           print: price, size
 *
 * `t` is epoch ms, prices are decimals in quoted units (ZB 117'16 is 117.5), sizes are contracts. Prints carry no
 * side; replay infers the aggressor from the quote in force, as the live feed does. The trading day is Chicago
 * time with the 17:00 open starting the next day. Any vendor's data can be converted to this and replayed.
 */
export interface MetaRecord { k: "meta"; v: 1; root: Root; code: string; month: string; source: string }
export interface QuoteRecord { k: "q"; t: number; b: number; a: number; bs: number; as: number }
export interface PrintRecord { k: "p"; t: number; p: number; s: number }
export type TickRecord = QuoteRecord | PrintRecord;

export const tickPath = (dir: string, root: Root, code: string, day: string) => join(dir, root, code, `${day}.jsonl`);

export const contractFromMeta = (m: MetaRecord): FuturesContract =>
  ({ ...contractFor(m.root, Number(m.month.slice(0, 4)), Number(m.month.slice(4, 6))), code: m.code });

/** Lines of a text file, gunzipped on the fly for `.gz`, without loading the file into memory. */
export async function* readLines(path: string): AsyncGenerator<string> {
  let stream: ReadableStream<Uint8Array> = Bun.file(path).stream();
  if (path.endsWith(".gz")) stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const parts = (rest + dec.decode(chunk, { stream: true })).split("\n");
    rest = parts.pop()!;
    for (const line of parts) if (line.trim()) yield line;
  }
  rest += dec.decode();
  if (rest.trim()) yield rest;
}

/** One day file: its meta line, then the records in file order. */
export async function* readTickFile(path: string): AsyncGenerator<MetaRecord | TickRecord> {
  let first = true;
  for await (const line of readLines(path)) {
    const r = JSON.parse(line) as MetaRecord | TickRecord;
    if (first && r.k !== "meta") throw new Error(`${path}: first line must be the meta record`);
    first = false;
    yield r;
  }
}

export interface DayFile { root: Root; code: string; day: string; path: string }

/** Every day file under `dir` for these roots, within [from, to] (trading days, inclusive), sorted by day. */
export function indexTicks(dir: string, roots: Root[], from?: string, to?: string): DayFile[] {
  const out: DayFile[] = [];
  for (const root of roots) {
    const rootDir = join(dir, root);
    if (!existsSync(rootDir)) continue;
    for (const code of readdirSync(rootDir)) {
      for (const f of readdirSync(join(rootDir, code))) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/.exec(f);
        if (!m) continue;
        const day = m[1]!;
        if ((from && day < from) || (to && day > to)) continue;
        out.push({ root, code, day, path: join(rootDir, code, f) });
      }
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.root.localeCompare(b.root) || a.code.localeCompare(b.code));
}

/**
 * Buffered appender for the recorder and downloaders. Writes the meta line when it creates a file; call `flush`
 * on a timer and before exit.
 */
export class TickWriter {
  private buf = new Map<string, string[]>();
  written = 0;

  constructor(private dir: string, private source: string) {}

  write(c: FuturesContract, day: string, rec: TickRecord) {
    const path = tickPath(this.dir, c.root, c.code, day);
    let lines = this.buf.get(path);
    if (!lines) {
      lines = [];
      this.buf.set(path, lines);
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const meta: MetaRecord = { k: "meta", v: 1, root: c.root, code: c.code, month: c.month, source: this.source };
        lines.push(JSON.stringify(meta));
      }
    }
    lines.push(JSON.stringify(rec));
    this.written++;
  }

  flush() {
    for (const [path, lines] of this.buf) {
      if (!lines.length) continue;
      appendFileSync(path, lines.join("\n") + "\n");
      lines.length = 0;
    }
  }
}

/**
 * Page through [start, end) with a source that returns up to `pageSize` ticks from a start time, oldest first,
 * stamped to whole seconds (IBKR historical ticks). A full page's last second may continue on the next page, so
 * it is dropped and re-requested from that second; a page that is all one second moves on to the next second.
 */
export async function pageTicks<T extends { t: number }>(
  get: (startMs: number) => Promise<T[]>, start: number, end: number,
  o: { pageSize?: number; pause?: () => Promise<void>; onError?: (at: number, e: Error) => void } = {},
): Promise<T[]> {
  const size = o.pageSize ?? 1000;
  const out: T[] = [];
  for (let at = start; at < end;) {
    let page: T[] = [];
    try { page = await get(at); } catch (e) { o.onError?.(at, e as Error); }
    await o.pause?.();
    if (!page.length) break;
    const lastSec = page.at(-1)!.t;
    const full = page.length >= size;
    let keep = page;
    if (full) {
      const before = page.filter((p) => p.t < lastSec);
      keep = before.length ? before : page;
      at = before.length ? lastSec : lastSec + 1000;
    }
    out.push(...keep.filter((p) => p.t >= start && p.t < end));
    if (!full || lastSec >= end) break;
  }
  return out;
}

/** Ticks sharing a whole-second stamp are spread evenly across that second, keeping their order. */
export function spreadWithinSecond<T extends { t: number }>(ticks: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ticks.length;) {
    let j = i;
    while (j < ticks.length && ticks[j]!.t === ticks[i]!.t) j++;
    for (let k = i; k < j; k++) out.push({ ...ticks[k]!, t: ticks[k]!.t + Math.floor(((k - i) * 1000) / (j - i)) });
    i = j;
  }
  return out;
}

export const tradingDay = (root: Root, ts: number) => SPECS[root].session.tradingDay(new Date(ts));
