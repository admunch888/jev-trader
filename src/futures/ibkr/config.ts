const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

/** TWS / IB Gateway API ports. Paper and live accounts listen on different ports, which is what the live guard keys on. */
export const IB_PORTS = { twsLive: 7496, twsPaper: 7497, gatewayLive: 4001, gatewayPaper: 4002 } as const;
const PAPER_PORTS: number[] = [IB_PORTS.twsPaper, IB_PORTS.gatewayPaper];

export const ibConfig = {
  host: env("IB_HOST", "127.0.0.1")!,
  port: Number(env("IB_PORT", String(IB_PORTS.gatewayPaper))),
  /** Market data connects as this client id, execution as this + 1. Each must be unique per TWS/Gateway instance. */
  clientId: Number(env("IB_CLIENT_ID", "10")),
  /** Restrict orders and account queries to one account (FA / multi-account logins). */
  account: env("IB_ACCOUNT"),
  /** 1 realtime (needs CME/CBOT subscriptions), 3 delayed. Delayed data is flagged on every snapshot and must not drive live orders. */
  marketDataType: Number(env("IB_MARKET_DATA_TYPE", "1")),
  /** Execution refuses to connect to a live port unless this is "true". */
  allowLive: env("IB_LIVE") === "true",
  reconnectMs: 5_000,
  requestTimeoutMs: 10_000,
};

export const isPaperPort = (port: number) => PAPER_PORTS.includes(port);
