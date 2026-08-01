export interface PriceSignals {
  priceUsd: number;
  drawdownPct: number;
  volatilityPct: number;
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<number[][]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance price feed error (${res.status})`);
  return (await res.json()) as number[][];
}

export async function getPriceSignals(symbol = "ETHUSDC"): Promise<PriceSignals> {
  const klines = await fetchKlines(symbol, "1m", 6);

  const highs = klines.map((k) => Number(k[2]));
  const lows = klines.map((k) => Number(k[3]));
  const closes = klines.map((k) => Number(k[4]));

  const priceUsd = closes[closes.length - 1];
  const peak = Math.max(...highs);
  const drawdownPct = ((peak - priceUsd) / peak) * 100;

  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const volatilityPct = Math.sqrt(variance) * 100;

  return { priceUsd, drawdownPct, volatilityPct };
}
