// ═══════════════════════════════════════════════════════════════════
// CORS-AWARE FETCH
// Tries direct first → falls back to corsproxy.io if blocked
// Remembers which hosts need proxy to skip failed attempts
// ═══════════════════════════════════════════════════════════════════
const needsProxy = {};
const PROXY = 'https://corsproxy.io/?url=';

async function cFetch(url) {
  const host = new URL(url).host;
  const t0 = performance.now();
  if (needsProxy[host] && G.useProxy) return proxyFetch(url, t0);
  try {
    const r = await fetch(url);
    const lat = Math.round(performance.now() - t0);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, data: await r.json(), lat, proxied: false };
  } catch (e) {
    if (G.useProxy) { needsProxy[host] = true; return proxyFetch(url, t0); }
    return { ok: false, err: `${e.message} (CORS? Enable proxy in Config)`, lat: Math.round(performance.now() - t0), proxied: false };
  }
}

async function proxyFetch(url, t0) {
  try {
    const r = await fetch(PROXY + encodeURIComponent(url));
    const lat = Math.round(performance.now() - t0);
    if (!r.ok) throw new Error(`Proxy HTTP ${r.status}`);
    return { ok: true, data: await r.json(), lat, proxied: true };
  } catch (e) {
    return { ok: false, err: `Proxy failed: ${e.message}`, lat: Math.round(performance.now() - t0), proxied: true };
  }
}

// ═══════════════════════════════════════════════════════════════════
// IV SOLVER (Newton-Raphson) — for cross-exchange vol comparison only
// ═══════════════════════════════════════════════════════════════════
const phi = x => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1, ax = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return 0.5 * (1 + s * y);
};

const bsP = (S, K, T, r, v, cp) => {
  if (T <= 1e-6 || v <= 1e-6) return Math.max(0, cp === 'C' ? S - K : K - S);
  const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * sq), d2 = d1 - v * sq;
  return cp === 'C' ? S * phi(d1) - K * Math.exp(-r * T) * phi(d2) : K * Math.exp(-r * T) * phi(-d2) - S * phi(-d1);
};

const solveIV = (price, S, K, T, r, cp) => {
  if (T <= 1e-6 || price <= 0) return null;
  let v = 0.5;
  for (let i = 0; i < 50; i++) {
    const p = bsP(S, K, T, r, v, cp);
    const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T));
    const vg = S * Math.sqrt(T) * Math.exp(-d1 * d1 / 2) / 2.5066282746;
    if (vg < 1e-10) break;
    v -= (p - price) / vg;
    if (v <= 0.001) v = 0.001;
    if (v > 10) v = 10;
    if (Math.abs(p - price) < 1e-8) break;
  }
  return (v > 0.001 && v < 10) ? v : null;
};

// ═══════════════════════════════════════════════════════════════════
// PARSERS
// ═══════════════════════════════════════════════════════════════════
const MO = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const MN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dTE(d) { return Math.max(0, (d.getTime() - Date.now()) / 864e5); }

// PT: BTC-20260328-70000C
function parsePTOpt(sym) {
  const m = sym.match(/^(\w+)-(\d{8})-(\d+)(C|P)$/);
  if (!m) return null;
  const [, a, ds, k, cp] = m;
  const y = parseInt(ds.slice(0, 4)), mo = parseInt(ds.slice(4, 6)) - 1, d = parseInt(ds.slice(6, 8));
  return { asset: a, strike: parseInt(k), cp, expiry: `${d}${MN[mo]}${String(y).slice(2)}`, expiryDate: new Date(y, mo, d, 8, 0, 0) };
}

// Deribit/Bybit: BTC-28MAR26-70000-C
function parseDI(n) {
  const m = n.match(/^(\w+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(C|P)$/);
  if (!m) return null;
  const [, a, day, mon, yr, k, cp] = m, y = 2000 + parseInt(yr), mo = MO[mon];
  if (mo === undefined) return null;
  return { asset: a, strike: parseInt(k), cp, expiry: `${day}${mon}${yr}`, expiryDate: new Date(y, mo, parseInt(day), 8, 0, 0) };
}

// OKX: BTC-USD-260328-70000-C
function parseOI(n) {
  const m = n.match(/^(\w+)-USD-(\d{6})-(\d+)-(C|P)$/);
  if (!m) return null;
  const [, a, ds, k, cp] = m;
  const y = 2000 + parseInt(ds.slice(0, 2)), mo = parseInt(ds.slice(2, 4)) - 1, d = parseInt(ds.slice(4, 6));
  const mn = Object.keys(MO).find(k => MO[k] === mo) || '???';
  return { asset: a, strike: parseInt(k), cp, expiry: `${d}${mn}${ds.slice(0, 2)}`, expiryDate: new Date(y, mo, d, 8, 0, 0) };
}

// ═══════════════════════════════════════════════════════════════════
// EXCHANGE FETCHERS
// ═══════════════════════════════════════════════════════════════════
async function fetchPT() {
  const r = await cFetch('https://api.rest.prod.power.trade/v1/market_data/tradeable_entity/all/summary');
  if (!r.ok) return { opts: [], perps: [], spots: {}, ok: false, lat: r.lat, err: r.err, proxied: r.proxied };
  const opts = [], perps = [], spots = {};
  for (const t of r.data) {
    const bid = t.best_bid ? parseFloat(t.best_bid) : null;
    const ask = t.best_ask ? parseFloat(t.best_ask) : null;
    const last = t.last_price ? parseFloat(t.last_price) : null;
    const idx = t.index_price ? parseFloat(t.index_price) : null;
    const vol = t.volume ? parseFloat(t.volume) : 0;
    const oi = t.open_interest ? parseFloat(t.open_interest) : 0;
    if (t.product_type === 'option') {
      const p = parsePTOpt(t.symbol); if (!p) continue;
      const S = idx || 0, mid = bid != null && ask != null ? (bid + ask) / 2 : (bid || ask || last || 0);
      const sprd = bid != null && ask != null && mid > 0 ? ((ask - bid) / mid) * 100 : null;
      opts.push({ ex: 'PT', asset: p.asset, strike: p.strike, expiry: p.expiry, expiryDate: p.expiryDate, cp: p.cp,
        T: dTE(p.expiryDate) / 365, bid, ask, mid, last, spot: S, sprd, vol24h: vol, oi, raw: t.symbol, id: t.id });
      if (S > 0) spots[p.asset] = S;
    } else if (t.product_type === 'perpetual_future') {
      const asset = t.symbol.split('-')[0], mark = last || ((bid || 0) + (ask || 0)) / 2;
      perps.push({ ex: 'PT', asset, isPerpetual: true, instrument: t.symbol, mark, bid, ask, last, vol24h: vol, oi, spot: idx || 0,
        funding: null, basis: idx > 0 ? (mark - idx) / idx * 100 : 0, id: t.id });
      if (idx > 0) spots[asset] = idx;
    } else if (t.product_type === 'index') {
      const asset = t.symbol.split('-')[0]; if (idx > 0) spots[asset] = idx;
    }
  }
  return { opts, perps, spots, ok: true, lat: r.lat, count: r.data.length, proxied: r.proxied };
}

async function fetchDeribit(asset) {
  const [oR, fR] = await Promise.all([
    cFetch(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=option`),
    cFetch(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=future`)]);
  const opts = [], perps = []; let proxied = oR.proxied || fR.proxied;
  if (oR.ok && oR.data?.result) {
    for (const o of oR.data.result) {
      const p = parseDI(o.instrument_name); if (!p) continue;
      const S = o.underlying_price || 0; if (!S) continue;
      const bid = (o.bid_price || 0) * S, ask = (o.ask_price || 0) * S, mark = (o.mark_price || 0) * S;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : mark;
      const sprd = mid > 0 && bid > 0 && ask > 0 ? ((ask - bid) / mid) * 100 : null;
      opts.push({ ex: 'Deribit', asset: p.asset, strike: p.strike, expiry: p.expiry, expiryDate: p.expiryDate, cp: p.cp,
        T: dTE(p.expiryDate) / 365, bid, ask, mid, spot: S, markIv: o.mark_iv ? o.mark_iv / 100 : null,
        sprd, vol24h: o.volume || 0, oi: o.open_interest || 0, raw: o.instrument_name });
    }
  }
  if (fR.ok && fR.data?.result) {
    for (const f of fR.data.result) {
      const S = f.underlying_price || 0; if (!S) continue;
      perps.push({ ex: 'Deribit', asset, isPerpetual: f.instrument_name.includes('PERPETUAL'), instrument: f.instrument_name,
        mark: f.mark_price || 0, bid: f.bid_price || 0, ask: f.ask_price || 0, vol24h: f.volume || 0, oi: f.open_interest || 0,
        spot: S, funding: f.current_funding != null ? f.current_funding : null, basis: S > 0 ? ((f.mark_price || S) - S) / S * 100 : 0 });
    }
  }
  return { opts, perps, oOk: oR.ok, fOk: fR.ok, lat: Math.max(oR.lat, fR.lat), oErr: oR.err, fErr: fR.err, proxied };
}

async function fetchOKX(asset) {
  const fam = `${asset}-USD`;
  const [oR, sR, iR] = await Promise.all([
    cFetch(`https://www.okx.com/api/v5/market/tickers?instType=OPTION&instFamily=${fam}`),
    cFetch(`https://www.okx.com/api/v5/market/tickers?instType=SWAP&instFamily=${fam}`),
    cFetch(`https://www.okx.com/api/v5/market/index-tickers?instId=${asset}-USD`)]);
  const opts = [], perps = []; let spot = 0, proxied = oR.proxied || sR.proxied;
  if (iR.ok && iR.data?.data?.[0]) spot = parseFloat(iR.data.data[0].idxPx) || 0;
  if (oR.ok && oR.data?.data) {
    for (const o of oR.data.data) {
      const p = parseOI(o.instId); if (!p) continue; const S = spot; if (!S) continue;
      const bid = (parseFloat(o.bidPx) || 0) * S, ask = (parseFloat(o.askPx) || 0) * S;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const sprd = mid > 0 ? ((ask - bid) / mid) * 100 : null;
      opts.push({ ex: 'OKX', asset: p.asset, strike: p.strike, expiry: p.expiry, expiryDate: p.expiryDate, cp: p.cp,
        T: dTE(p.expiryDate) / 365, bid, ask, mid, spot: S, markIv: null, sprd, vol24h: parseFloat(o.volCcy24h) || 0, oi: parseFloat(o.oi) || 0, raw: o.instId });
    }
  }
  if (sR.ok && sR.data?.data) {
    for (const f of sR.data.data) {
      if (!f.instId.includes(asset)) continue; const S = spot, mk = parseFloat(f.last) || 0;
      perps.push({ ex: 'OKX', asset, isPerpetual: true, instrument: f.instId, mark: mk, bid: parseFloat(f.bidPx) || 0, ask: parseFloat(f.askPx) || 0,
        vol24h: parseFloat(f.volCcy24h) || 0, oi: parseFloat(f.oi) || 0, spot: S, funding: f.fundingRate != null ? parseFloat(f.fundingRate) : null, basis: S > 0 ? (mk - S) / S * 100 : 0 });
    }
  }
  return { opts, perps, oOk: oR.ok, fOk: sR.ok, lat: Math.max(oR.lat, sR.lat || 0, iR.lat || 0), proxied };
}

async function fetchBybit(asset) {
  const [oR, lR] = await Promise.all([
    cFetch(`https://api.bybit.com/v5/market/tickers?category=option&baseCoin=${asset}`),
    cFetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${asset}USDT`)]);
  const opts = [], perps = []; let proxied = oR.proxied || lR.proxied;
  if (oR.ok && oR.data?.result?.list) {
    for (const o of oR.data.result.list) {
      const p = parseDI(o.symbol); if (!p) continue;
      const S = parseFloat(o.underlyingPrice) || 0; if (!S) continue;
      const bid = parseFloat(o.bid1Price) || 0, ask = parseFloat(o.ask1Price) || 0, mark = parseFloat(o.markPrice) || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : mark;
      const sprd = mid > 0 && bid > 0 && ask > 0 ? ((ask - bid) / mid) * 100 : null;
      opts.push({ ex: 'Bybit', asset: p.asset, strike: p.strike, expiry: p.expiry, expiryDate: p.expiryDate, cp: p.cp,
        T: dTE(p.expiryDate) / 365, bid, ask, mid, spot: S, markIv: o.markIv ? parseFloat(o.markIv) : null,
        sprd, vol24h: parseFloat(o.volume24h) || 0, oi: parseFloat(o.openInterest) || 0, raw: o.symbol });
    }
  }
  if (lR.ok && lR.data?.result?.list) {
    for (const f of lR.data.result.list) {
      const mk = parseFloat(f.markPrice) || parseFloat(f.lastPrice) || 0, S = parseFloat(f.indexPrice) || mk;
      perps.push({ ex: 'Bybit', asset, isPerpetual: true, instrument: f.symbol, mark: mk, bid: parseFloat(f.bid1Price) || 0, ask: parseFloat(f.ask1Price) || 0,
        vol24h: parseFloat(f.volume24h) || 0, oi: parseFloat(f.openInterest) || 0, spot: S, funding: f.fundingRate != null ? parseFloat(f.fundingRate) : null, basis: S > 0 ? (mk - S) / S * 100 : 0 });
    }
  }
  return { opts, perps, oOk: oR.ok, fOk: lR.ok, lat: Math.max(oR.lat, lR.lat), proxied };
}

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════
const FEES = { PT: { m: 0.0003, t: 0.0005 }, Deribit: { m: 0.0002, t: 0.0003 }, OKX: { m: 0.0002, t: 0.0003 }, Bybit: { m: 0.0002, t: 0.0004 } };

const G = {
  tab: 'health', loading: true, tick: 0, live: true, openA: null, useProxy: true,
  fAsset: 'ALL', fCat: 'ALL', fSev: 'ALL', fProf: false,
  hAsset: 'ALL', hExpiry: 'ALL', hFilter: 'ALL', compAsset: 'BTC', compExpiry: null,
  th: { ptSprd: 15, ptVsMkt: 20, ivArb: 8, perpBps: 5, fundBps: 6, lowVolPct: 10 },
  refreshMs: 25000,
  conn: { PT: { ok: false }, Deribit: { ok: false }, OKX: { ok: false }, Bybit: { ok: false } },
  ptOpts: [], ptPerps: [], ptItems: [], mktOpts: [], mktPerps: [], alerts: [], spots: {}, lastUp: null, errors: []
};
let timer = null;

// ═══════════════════════════════════════════════════════════════════
// ORDERBOOK HEALTH ANALYSIS
// ═══════════════════════════════════════════════════════════════════
function analyzeHealth(ptOpts) {
  const items = ptOpts.map(o => {
    const hasBid = o.bid != null && o.bid > 0, hasAsk = o.ask != null && o.ask > 0;
    let status = 'EMPTY';
    if (hasBid && hasAsk) status = o.sprd != null && o.sprd >= G.th.ptSprd ? 'WIDE' : 'QUOTED';
    else if (hasBid || hasAsk) status = 'ONE_SIDED';
    return { ...o, hasBid, hasAsk, status };
  });
  // Volume comparison within each expiry group
  const byG = {};
  for (const o of items) { const g = `${o.asset}-${o.expiry}`; if (!byG[g]) byG[g] = []; byG[g].push(o); }
  for (const arr of Object.values(byG)) {
    const vols = arr.map(a => a.vol24h).filter(v => v > 0);
    const avgV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const maxV = vols.length ? Math.max(...vols) : 0;
    for (const o of arr) {
      o.groupAvgVol = avgV; o.groupMaxVol = maxV;
      o.volPctOfMax = maxV > 0 ? o.vol24h / maxV * 100 : 0;
      o.isLowVol = avgV > 0 && o.vol24h > 0 && o.vol24h < avgV * (G.th.lowVolPct / 100);
      o.isZeroVol = o.vol24h === 0;
    }
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════
// ALERT DETECTION
// ═══════════════════════════════════════════════════════════════════
function detect(ptItems, ptPerps, mktOpts, mktPerps, th) {
  const al = [];
  // PT internal issues
  for (const o of ptItems) {
    if (o.status === 'ONE_SIDED')
      al.push({ cat: 'PT_STALE', sev: 'warning', asset: o.asset, title: o.raw, val: 0,
        msg: `One-sided: ${o.hasBid ? 'Bid $' + o.bid.toFixed(2) + ' only' : 'Ask $' + o.ask.toFixed(2) + ' only'}`,
        detail: `OI: ${o.oi} | Vol: $${o.vol24h} | Spot: $${o.spot?.toFixed(0) || '?'}`, net: 0, profitable: false, act: '⚠ Check MM quoting' });
    if (o.status === 'WIDE')
      al.push({ cat: 'PT_WIDE', sev: o.sprd >= th.ptSprd * 2 ? 'critical' : 'warning', asset: o.asset, title: o.raw,
        val: o.sprd, msg: `Spread ${o.sprd.toFixed(1)}% — Bid $${o.bid.toFixed(2)} / Ask $${o.ask.toFixed(2)}`,
        detail: `Mid: $${o.mid.toFixed(2)} | OI: ${o.oi}`, net: 0, profitable: false, act: '⚠ Wide — flag to MM' });
  }
  // PT vs Market
  const mktByK = {};
  for (const o of mktOpts) { if (o.T < 0.001 || o.mid <= 0) continue; const k = `${o.asset}-${o.strike}-${o.expiry}-${o.cp}`; if (!mktByK[k]) mktByK[k] = []; mktByK[k].push(o); }
  for (const pt of ptItems) {
    if (pt.mid <= 0 || pt.T < 0.001) continue;
    const k = `${pt.asset}-${pt.strike}-${pt.expiry}-${pt.cp}`;
    const mkts = mktByK[k]; if (!mkts) continue;
    const mids = mkts.filter(m => m.mid > 0).map(m => m.mid);
    if (!mids.length) continue;
    const mktMid = mids.reduce((a, b) => a + b, 0) / mids.length;
    const diff = ((pt.mid - mktMid) / mktMid) * 100, ad = Math.abs(diff);
    if (ad >= th.ptVsMkt) {
      const cheap = diff < 0;
      const best = cheap ? mkts.reduce((a, b) => (b.bid || 0) > (a.bid || 0) ? b : a, mkts[0]) : mkts.reduce((a, b) => ((b.ask || 0) < (a.ask || 0) && b.ask > 0) ? b : a, mkts[0]);
      const actionable = cheap ? (pt.ask != null && pt.ask < (best.bid || 0)) : (pt.bid != null && pt.bid > (best.ask || Infinity));
      const gross = actionable ? (cheap ? (best.bid || 0) - pt.ask : pt.bid - (best.ask || 0)) : 0;
      const S = pt.spot || mktMid, fees = (FEES.PT.t + (FEES[best.ex]?.t || 0.0005)) * S, net = gross - fees;
      al.push({ cat: cheap ? 'PT_CHEAP' : 'PT_RICH', sev: ad >= th.ptVsMkt * 2 ? 'critical' : 'warning', asset: pt.asset, title: pt.raw, val: ad,
        msg: `PT mid $${pt.mid.toFixed(2)} vs Mkt $${mktMid.toFixed(2)} (${diff > 0 ? '+' : ''}${diff.toFixed(1)}%)`,
        detail: `PT: $${pt.bid?.toFixed(2) || '—'}/$${pt.ask?.toFixed(2) || '—'} | ${best.ex}: $${best.bid?.toFixed(2) || '—'}/$${best.ask?.toFixed(2) || '—'}${actionable ? ` | Net: $${net.toFixed(2)}` : ''}`,
        net: actionable ? net : 0, profitable: actionable && net > 0,
        act: cheap ? (actionable ? `BUY PT@$${pt.ask?.toFixed(2)} → SELL ${best.ex}@$${(best.bid || 0).toFixed(2)}` : 'PT cheap but not arb-able')
          : (actionable ? `SELL PT@$${pt.bid?.toFixed(2)} → BUY ${best.ex}@$${(best.ask || 0).toFixed(2)}` : 'PT rich but not arb-able') });
    }
  }
  // Perps
  const pBA = {};
  for (const p of [...ptPerps, ...mktPerps]) { if (!p.isPerpetual) continue; if (!pBA[p.asset]) pBA[p.asset] = {}; pBA[p.asset][p.ex] = p; }
  for (const [asset, em] of Object.entries(pBA)) {
    const pt = em.PT; if (!pt) continue;
    for (const [ex, mp] of Object.entries(em)) {
      if (ex === 'PT') continue;
      const bd = Math.abs(pt.basis - mp.basis) * 100;
      if (bd >= th.perpBps) al.push({ cat: 'PERP_ARB', sev: bd > th.perpBps * 2 ? 'critical' : 'warning', asset, title: `${asset} PERP PT↔${ex}`,
        val: bd, msg: `Basis Δ ${bd.toFixed(1)}bps`, detail: `PT: $${pt.mark.toFixed(2)} | ${ex}: $${mp.mark.toFixed(2)}`,
        net: Math.abs(pt.mark - mp.mark), profitable: bd > 3, act: pt.mark < mp.mark ? `LONG PT / SHORT ${ex}` : `SHORT PT / LONG ${ex}` });
    }
  }
  return al.sort((a, b) => (a.sev === 'critical' ? 0 : 1) - (b.sev === 'critical' ? 0 : 1) || b.val - a.val);
}

// ═══════════════════════════════════════════════════════════════════
// REFRESH CYCLE
// ═══════════════════════════════════════════════════════════════════
async function refresh() {
  G.loading = true; render(); const errs = [];
  G.conn = { PT: { ok: false, n: 0, lat: 0 }, Deribit: { ok: false, n: 0, lat: 0 }, OKX: { ok: false, n: 0, lat: 0 }, Bybit: { ok: false, n: 0, lat: 0 } };
  const [ptR, ...mktRs] = await Promise.allSettled([fetchPT(), fetchDeribit('BTC'), fetchDeribit('ETH'), fetchOKX('BTC'), fetchOKX('ETH'), fetchBybit('BTC'), fetchBybit('ETH')]);
  if (ptR.status === 'fulfilled' && ptR.value) {
    const d = ptR.value;
    if (d.ok) { G.ptOpts = d.opts; G.ptPerps = d.perps; G.conn.PT = { ok: true, n: d.count, lat: d.lat, proxied: d.proxied }; Object.assign(G.spots, d.spots); }
    else { errs.push(`PT: ${d.err}`); G.ptOpts = []; G.ptPerps = []; G.conn.PT = { ok: false, err: d.err }; }
  } else { errs.push(`PT: ${ptR.reason || 'failed'}`); G.ptOpts = []; G.ptPerps = []; }
  let mo = [], mp = [];
  const mL = ['Deribit BTC', 'Deribit ETH', 'OKX BTC', 'OKX ETH', 'Bybit BTC', 'Bybit ETH'];
  const mE = ['Deribit', 'Deribit', 'OKX', 'OKX', 'Bybit', 'Bybit'];
  mktRs.forEach((r, i) => {
    const ex = mE[i];
    if (r.status === 'fulfilled' && r.value) {
      const d = r.value;
      if (d.oOk) { mo = mo.concat(d.opts); G.conn[ex].ok = true; G.conn[ex].n = (G.conn[ex].n || 0) + d.opts.length; G.conn[ex].lat = Math.max(G.conn[ex].lat || 0, d.lat); if (d.proxied) G.conn[ex].proxied = true; }
      if (d.fOk) { mp = mp.concat(d.perps); G.conn[ex].ok = true; G.conn[ex].n = (G.conn[ex].n || 0) + d.perps.length; }
      for (const p of d.perps || []) if (p.spot > 0) G.spots[p.asset] = p.spot;
      for (const o of d.opts || []) if (o.spot > 0 && !G.spots[o.asset]) G.spots[o.asset] = o.spot;
    } else errs.push(`${mL[i]}: ${r.reason || 'failed'}`);
  });
  G.mktOpts = mo; G.mktPerps = mp;
  G.ptItems = analyzeHealth(G.ptOpts);
  G.alerts = detect(G.ptItems, G.ptPerps, mo, mp, G.th);
  G.errors = errs; G.loading = false; G.lastUp = new Date(); G.tick++;
  if (!G.compExpiry) { const es = [...new Set(G.ptOpts.filter(o => o.asset === G.compAsset).map(o => o.expiry))]; if (es.length) G.compExpiry = es[0]; }
  render();
}

// ═══════════════════════════════════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════════════════════════════════
const $n = v => typeof v === 'number' ? v.toLocaleString() : v;
const $$ = v => typeof v === 'number' ? '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const bg = (t, c) => `<span class="badge bg-${c}">${t}</span>`;

// ═══════════════════════════════════════════════════════════════════
// TAB: ORDERBOOK HEALTH
// ═══════════════════════════════════════════════════════════════════
function rHealth() {
  const items = G.ptItems || []; if (!items.length) return `<div class="empty">No PT option data loaded — check connections above</div>`;
  const { hAsset, hExpiry, hFilter } = G;
  const assets = [...new Set(items.map(o => o.asset))].sort();
  const fa = items.filter(o => (hAsset === 'ALL' || o.asset === hAsset));
  const expiries = [...new Set(fa.map(o => o.expiry))].sort((a, b) => { const oa = fa.find(o => o.expiry === a), ob = fa.find(o => o.expiry === b); return (oa?.expiryDate?.getTime() || 0) - (ob?.expiryDate?.getTime() || 0); });
  const curExp = hExpiry !== 'ALL' && expiries.includes(hExpiry) ? hExpiry : 'ALL';
  let fi = fa.filter(o => curExp === 'ALL' || o.expiry === curExp);
  if (hFilter === 'EMPTY') fi = fi.filter(o => o.status === 'EMPTY');
  else if (hFilter === 'ONE_SIDED') fi = fi.filter(o => o.status === 'ONE_SIDED');
  else if (hFilter === 'WIDE') fi = fi.filter(o => o.status === 'WIDE');
  else if (hFilter === 'LOW_VOL') fi = fi.filter(o => o.isLowVol || o.isZeroVol);
  else if (hFilter === 'PROBLEMS') fi = fi.filter(o => o.status !== 'QUOTED');

  const total = fa.length, quoted = fa.filter(o => o.status === 'QUOTED').length, wide = fa.filter(o => o.status === 'WIDE').length;
  const oneSided = fa.filter(o => o.status === 'ONE_SIDED').length, empty = fa.filter(o => o.status === 'EMPTY').length;
  const zeroVol = fa.filter(o => o.isZeroVol).length;
  const hp = total > 0 ? Math.round(quoted / total * 100) : 0;
  const hc = hp >= 70 ? 'var(--grn)' : hp >= 40 ? 'var(--org)' : 'var(--red)';

  let h = `<div class="grid g2" style="margin-bottom:8px">
    <div class="card" style="display:flex;align-items:center;gap:16px">
      <div class="score-ring" style="color:${hc};border-color:${hc}">${hp}%</div>
      <div><div class="card-t" style="color:${hc};margin-bottom:2px">ORDERBOOK HEALTH${hAsset !== 'ALL' ? ' — ' + hAsset : ''}</div>
        <div class="mono dim" style="font-size:8px;line-height:1.5">${total} options listed · ${quoted} properly quoted (two-sided, spread &lt;${G.th.ptSprd}%)<br>
        ${wide} wide · ${oneSided} one-sided · ${empty} empty · ${zeroVol} zero volume</div></div></div>
    <div class="card"><div class="card-t" style="margin-bottom:4px">STATUS BREAKDOWN</div>
      <div class="grid g4" style="gap:4px">
        <div style="text-align:center"><div class="mono" style="font-size:16px;font-weight:800;color:var(--grn)">${quoted}</div><div class="mono dim" style="font-size:7px">QUOTED</div></div>
        <div style="text-align:center"><div class="mono" style="font-size:16px;font-weight:800;color:var(--org)">${wide}</div><div class="mono dim" style="font-size:7px">WIDE</div></div>
        <div style="text-align:center"><div class="mono" style="font-size:16px;font-weight:800;color:var(--red)">${oneSided}</div><div class="mono dim" style="font-size:7px">1-SIDED</div></div>
        <div style="text-align:center"><div class="mono" style="font-size:16px;font-weight:800;color:var(--dim)">${empty}</div><div class="mono dim" style="font-size:7px">EMPTY</div></div></div>
      <div class="bar-w" style="margin-top:6px"><div style="display:flex;height:8px">
        <div style="width:${quoted / total * 100}%;background:var(--grn)"></div>
        <div style="width:${wide / total * 100}%;background:var(--org)"></div>
        <div style="width:${oneSided / total * 100}%;background:var(--red)"></div>
        <div style="width:${empty / total * 100}%;background:var(--mut)"></div></div></div></div></div>`;

  // Per-expiry breakdown
  if (curExp === 'ALL' && expiries.length > 1) {
    h += `<div class="card"><div class="card-t" style="margin-bottom:6px">HEALTH BY EXPIRY <span class="dim" style="font-weight:400;font-size:8px">click to drill in</span></div>
    <div class="tbl-w"><table class="tbl"><thead><tr><th>Expiry</th><th>Days</th><th>Total</th><th>Quoted</th><th>Wide</th><th>1-Sided</th><th>Empty</th><th>0-Vol</th><th>Health</th><th></th></tr></thead><tbody>`;
    for (const exp of expiries) {
      const eo = fa.filter(o => o.expiry === exp), q = eo.filter(o => o.status === 'QUOTED').length, w = eo.filter(o => o.status === 'WIDE').length;
      const os = eo.filter(o => o.status === 'ONE_SIDED').length, em = eo.filter(o => o.status === 'EMPTY').length;
      const zv = eo.filter(o => o.isZeroVol).length, ehp = eo.length > 0 ? Math.round(q / eo.length * 100) : 0;
      const ec = ehp >= 70 ? 'var(--grn)' : ehp >= 40 ? 'var(--org)' : 'var(--red)';
      const days = eo[0] ? Math.round(dTE(eo[0].expiryDate)) : 0;
      h += `<tr style="cursor:pointer" onclick="G.hExpiry='${exp}';render()"><td style="font-weight:600;color:var(--acc)">${exp}</td><td>${days}d</td>
        <td>${eo.length}</td><td class="pos">${q}</td><td class="${w ? 'risk-md' : 'dim'}">${w || '—'}</td><td class="${os ? 'neg' : 'dim'}">${os || '—'}</td>
        <td class="dim">${em || '—'}</td><td class="dim">${zv || '—'}</td>
        <td style="font-weight:700;color:${ec}">${ehp}%</td>
        <td><div class="bar-w" style="width:80px;display:inline-block"><div style="display:flex;height:6px">
          <div style="width:${q / eo.length * 100}%;background:var(--grn)"></div>
          <div style="width:${w / eo.length * 100}%;background:var(--org)"></div>
          <div style="width:${os / eo.length * 100}%;background:var(--red)"></div>
          <div style="width:${em / eo.length * 100}%;background:var(--mut)"></div></div></div></td></tr>`;
    }
    h += `</tbody></table></div></div>`;
  }

  // Filters
  h += `<div class="filters">
    ${['ALL', ...assets].map(a => `<button class="btn${hAsset === a ? ' btn-a' : ''}" onclick="G.hAsset='${a}';render()">${a}</button>`).join('')}
    <span style="width:4px"></span>
    ${curExp !== 'ALL' ? `<button class="btn btn-a" onclick="G.hExpiry='ALL';render()">← All Expiries</button>` : ''}
    ${expiries.slice(0, 10).map(e => `<button class="btn${curExp === e ? ' btn-a' : ''}" style="font-size:8px" onclick="G.hExpiry='${e}';render()">${e}</button>`).join('')}
    <span style="width:8px"></span>
    ${[{ id: 'ALL', l: 'All' }, { id: 'PROBLEMS', l: '⚠ Problems' }, { id: 'EMPTY', l: 'Empty' }, { id: 'ONE_SIDED', l: '1-Sided' }, { id: 'WIDE', l: 'Wide' }, { id: 'LOW_VOL', l: 'Low Vol' }].map(f => `<button class="btn${hFilter === f.id ? ' btn-a' : ''}" onclick="G.hFilter='${f.id}';render()">${f.l}</button>`).join('')}
    <span class="mono dim" style="margin-left:auto;font-size:8px">${fi.length} shown</span></div>`;
  if (!fi.length) return h + `<div class="empty">No options match filter</div>`;

  fi.sort((a, b) => { const so = { EMPTY: 0, ONE_SIDED: 1, WIDE: 2, QUOTED: 3 }; return (so[a.status] || 9) - (so[b.status] || 9) || a.asset.localeCompare(b.asset) || a.expiryDate - b.expiryDate || a.strike - b.strike || (a.cp === 'C' ? 0 : 1) - (b.cp === 'C' ? 0 : 1); });
  h += `<div class="tbl-w"><table class="tbl"><thead><tr><th>Status</th><th>Symbol</th><th>Asset</th><th>Expiry</th><th>Strike</th><th>C/P</th><th>Bid</th><th>Ask</th><th>Spread%</th><th>Last</th><th>Index</th><th>Vol24h</th><th>OI</th><th>Vol vs Peers</th></tr></thead><tbody>`;
  for (const o of fi.slice(0, 300)) {
    const sc = { EMPTY: 'red', ONE_SIDED: 'org', WIDE: 'org', QUOTED: 'grn' }[o.status];
    const sl = { EMPTY: '❌ EMPTY', ONE_SIDED: '⚠ 1-SIDED', WIDE: '⚡ WIDE', QUOTED: '✅ OK' }[o.status];
    const vb = o.groupMaxVol > 0 ? Math.min(o.vol24h / o.groupMaxVol * 100, 100) : 0;
    const vc = o.isZeroVol ? 'var(--mut)' : o.isLowVol ? 'var(--red)' : vb < 30 ? 'var(--org)' : 'var(--grn)';
    h += `<tr><td>${bg(sl, sc)}</td>
      <td style="font-weight:600;color:var(--acc)">${o.raw}</td><td>${o.asset}</td><td>${o.expiry}</td>
      <td>$${$n(o.strike)}</td><td>${o.cp}</td>
      <td class="${!o.hasBid ? 'dim' : ''}">${o.hasBid ? '$' + o.bid.toFixed(2) : '<span class="neg">—</span>'}</td>
      <td class="${!o.hasAsk ? 'dim' : ''}">${o.hasAsk ? '$' + o.ask.toFixed(2) : '<span class="neg">—</span>'}</td>
      <td class="${o.sprd != null && o.sprd >= G.th.ptSprd ? 'risk-hi' : o.sprd != null && o.sprd >= G.th.ptSprd * 0.5 ? 'risk-md' : 'dim'}">${o.sprd != null ? o.sprd.toFixed(1) + '%' : '—'}</td>
      <td class="dim">${o.last ? '$' + o.last.toFixed(2) : '—'}</td>
      <td class="dim">${o.spot ? '$' + $n(o.spot.toFixed(0)) : '—'}</td>
      <td class="${o.isZeroVol ? 'dim' : o.isLowVol ? 'neg' : ''}">${o.vol24h > 0 ? '$' + $n(Math.round(o.vol24h)) : '—'}</td>
      <td class="dim">${o.oi > 0 ? o.oi : '—'}</td>
      <td><div class="bar-w" style="width:60px;display:inline-block"><div class="bar" style="width:${vb}%;background:${vc}"></div></div>
        <span class="mono dim" style="font-size:7px;margin-left:2px">${o.isZeroVol ? 'ZERO' : o.isLowVol ? 'LOW' : vb > 0 ? Math.round(vb) + '%' : ''}</span></td></tr>`;
  }
  h += `</tbody></table></div>`;
  if (fi.length > 300) h += `<div class="mono dim" style="padding:4px;font-size:8px">Showing 300/${fi.length}</div>`;
  return h;
}

// ═══════════════════════════════════════════════════════════════════
// TAB: ALERTS
// ═══════════════════════════════════════════════════════════════════
function rAlerts() {
  const { alerts: al, fAsset, fCat, fSev, fProf, openA } = G; const cats = [...new Set(al.map(a => a.cat))];
  const assets = [...new Set(al.map(a => a.asset))].sort();
  const fa = al.filter(a => (fAsset === 'ALL' || a.asset === fAsset) && (fCat === 'ALL' || a.cat === fCat) && (fSev === 'ALL' || a.sev === fSev) && (!fProf || a.profitable));
  const sel = (id, v, os) => `<select class="flt" onchange="sF('${id}',this.value)">${os.map(o => `<option${v === o ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
  let h = `<div class="filters"><span class="mono dim" style="font-size:8px">FILTER:</span>${sel('fAsset', fAsset, ['ALL', ...assets])}${sel('fSev', fSev, ['ALL', 'critical', 'warning'])}${sel('fCat', fCat, ['ALL', ...cats])}
    <label style="display:flex;align-items:center;gap:3px;font-family:var(--fm);font-size:9px;color:var(--dim);cursor:pointer"><input type="checkbox" ${fProf ? 'checked' : ''} onchange="G.fProf=this.checked;render()"> Actionable only</label>
    <span class="mono dim" style="margin-left:auto;font-size:8px">${fa.length}/${al.length}</span></div>`;
  if (!fa.length) return h + `<div class="empty">${al.length ? 'No alerts match filters' : '✅ No alerts at current thresholds'}</div>`;
  const catCol = { PT_WIDE: 'org', PT_STALE: 'red', PT_CHEAP: 'grn', PT_RICH: 'prp', PERP_ARB: 'grn', FUND_ARB: 'blu' };
  const catLbl = { PT_WIDE: 'PT WIDE', PT_STALE: 'PT STALE', PT_CHEAP: 'PT CHEAP', PT_RICH: 'PT RICH', PERP_ARB: 'PERP ARB', FUND_ARB: 'FUNDING' };
  return h + fa.slice(0, 150).map(a => { const id = (a.title + a.cat).replace(/[^a-zA-Z0-9]/g, '_');
    return `<div class="alert-row${a.sev === 'critical' ? ' crit' : ''}${openA === id ? ' open' : ''}" onclick="togA('${id}')"><div class="alert-hd">
      ${bg(a.sev === 'critical' ? 'CRIT' : 'WARN', a.sev === 'critical' ? 'red' : 'org')} ${bg(catLbl[a.cat] || a.cat, catCol[a.cat] || 'acc')} ${bg(a.asset, 'acc')}
      ${a.profitable ? bg('ACTIONABLE', 'grn') : ''}<span class="alert-t">${a.title}</span></div>
      <div class="alert-d">${a.msg}<br>${a.detail}<br>
      ${a.profitable ? `<span class="pos" style="font-weight:700">Net: $${a.net.toFixed(2)}</span><br>` : ''}<span style="display:inline-block;margin-top:3px;padding:2px 8px;border-radius:2px;font-weight:700;background:${a.profitable ? 'var(--grnBg)' : 'rgba(230,168,23,.08)'};color:${a.profitable ? 'var(--grn)' : 'var(--acc)'}">→ ${a.act}</span></div></div>`; }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// TAB: PT vs MARKET
// ═══════════════════════════════════════════════════════════════════
function rComp() {
  const { ptOpts, mktOpts, compAsset: ca, compExpiry: ce } = G; const assets = [...new Set(ptOpts.map(o => o.asset))].sort();
  const ao = ptOpts.filter(o => o.asset === ca);
  const expiries = [...new Set(ao.map(o => o.expiry))].sort((a, b) => { const oa = ao.find(o => o.expiry === a), ob = ao.find(o => o.expiry === b); return (oa?.expiryDate?.getTime() || 0) - (ob?.expiryDate?.getTime() || 0); });
  const cur = ce && expiries.includes(ce) ? ce : expiries[0]; const ptExp = ao.filter(o => o.expiry === cur);
  const strikes = [...new Set(ptExp.map(o => o.strike))].sort((a, b) => a - b); const Sp = G.spots[ca] || 0;
  const mktExs = [...new Set(mktOpts.filter(o => o.asset === ca && o.expiry === cur).map(o => o.ex))].sort();
  let h = `<div class="filters">${assets.map(a => `<button class="btn${ca === a ? ' btn-a' : ''}" onclick="G.compAsset='${a}';G.compExpiry=null;render()">${a}</button>`).join('')}
    <span style="width:8px"></span>${expiries.slice(0, 12).map(e => `<button class="btn${cur === e ? ' btn-a' : ''}" style="font-size:8px" onclick="G.compExpiry='${e}';render()">${e}</button>`).join('')}
    <span class="mono dim" style="margin-left:auto;font-size:8px">Index: ${Sp ? '$' + $n(Sp.toFixed(0)) : '?'}</span></div>`;
  if (!strikes.length) return h + `<div class="empty">No PT options for ${ca} ${cur || ''}</div>`;
  h += `<div class="info-box">💡 <b>PT is reference.</b> Diff = (PT mid − Mkt avg) / Mkt avg. <span class="pos">Green = PT cheaper.</span> <span class="neg">Red = PT richer.</span>${!mktExs.length ? ' <b>No matching market expiry found.</b>' : ''}</div>`;
  if (!mktExs.length) return h;
  h += `<div class="tbl-w"><table class="tbl"><thead><tr><th>Strike</th><th>C/P</th><th style="color:var(--acc)">PT Bid</th><th style="color:var(--acc)">PT Ask</th><th style="color:var(--acc)">PT Sprd%</th>`;
  mktExs.forEach(e => { h += `<th>${e} Bid</th><th>${e} Ask</th>`; });
  h += `<th style="color:var(--cyn)">Diff%</th><th>Signal</th></tr></thead><tbody>`;
  for (const K of strikes) { for (const cp of ['C', 'P']) {
    const pt = ptExp.find(o => o.strike === K && o.cp === cp); if (!pt) continue; const atm = Sp > 0 && Math.abs(K - Sp) / Sp < 0.015;
    const mktD = mktExs.map(ex => mktOpts.find(m => m.asset === ca && m.strike === K && m.expiry === cur && m.cp === cp && m.ex === ex));
    const mktMids = mktD.filter(m => m && m.mid > 0).map(m => m.mid); const mktAvg = mktMids.length ? mktMids.reduce((a, b) => a + b, 0) / mktMids.length : 0;
    const diff = mktAvg > 0 && pt.mid > 0 ? ((pt.mid - mktAvg) / mktAvg * 100) : null; const ad = diff != null ? Math.abs(diff) : 0;
    const dc = diff == null ? 'dim' : ad < G.th.ptVsMkt ? 'dim' : diff < 0 ? 'pos' : 'neg';
    h += `<tr${atm ? ' style="background:rgba(230,168,23,.04)"' : ''}>
      <td style="font-weight:600${atm ? ';color:var(--acc)' : ''}">$${$n(K)}</td><td>${cp}</td>
      <td class="${pt.bid == null ? 'dim' : ''}">${pt.bid != null ? pt.bid.toFixed(2) : '<span class="neg">—</span>'}</td>
      <td class="${pt.ask == null ? 'dim' : ''}">${pt.ask != null ? pt.ask.toFixed(2) : '<span class="neg">—</span>'}</td>
      <td class="${pt.sprd != null && pt.sprd >= G.th.ptSprd ? 'risk-hi' : 'dim'}">${pt.sprd != null ? pt.sprd.toFixed(1) : '—'}</td>`;
    mktExs.forEach((ex, i) => { const m = mktD[i]; h += `<td class="dim">${m && m.bid > 0 ? m.bid.toFixed(2) : '—'}</td><td class="dim">${m && m.ask > 0 ? m.ask.toFixed(2) : '—'}</td>`; });
    h += `<td class="${dc}" style="font-weight:700">${diff != null ? (diff > 0 ? '+' : '') + diff.toFixed(1) + '%' : '—'}</td>
      <td style="font-size:8px">${diff == null ? '' : ad < G.th.ptVsMkt ? '✅' : diff < 0 ? '🟢 CHEAP' : '🔴 RICH'}</td></tr>`;
  }}
  h += `</tbody></table></div>`; return h;
}

// ═══════════════════════════════════════════════════════════════════
// TAB: PERPS
// ═══════════════════════════════════════════════════════════════════
function rPerps() {
  const allP = [...G.ptPerps, ...G.mktPerps.filter(p => p.isPerpetual)]; const assets = [...new Set(allP.map(p => p.asset))].sort();
  let h = ''; assets.forEach(asset => { const rows = allP.filter(p => p.asset === asset && p.isPerpetual); if (!rows.length) return;
    h += `<div class="card"><div class="card-h"><span class="card-t" style="color:var(--acc)">${asset} PERPETUAL</span><span class="mono dim" style="font-size:8px">Index: ${G.spots[asset] ? '$' + $n(G.spots[asset].toFixed(2)) : '?'}</span></div>
    <div class="tbl-w"><table class="tbl"><thead><tr><th>Exchange</th><th>Mark</th><th>Bid</th><th>Ask</th><th>Spread</th><th>Basis</th><th>Funding</th><th>Vol 24h</th><th>OI</th></tr></thead><tbody>
    ${rows.map(p => { const sp = p.bid != null && p.ask != null && p.bid > 0 && p.ask > 0 ? ((p.ask - p.bid) / ((p.bid + p.ask) / 2) * 10000).toFixed(1) : '—'; const isPT = p.ex === 'PT';
      return `<tr${isPT ? ' style="background:rgba(230,168,23,.05);border-left:3px solid var(--acc)"' : ''}>
        <td style="font-weight:600${isPT ? ';color:var(--acc)' : ''}">${p.ex}${isPT ? ' ★' : ''}</td>
        <td>${$$(p.mark)}</td><td class="pos">${p.bid != null ? $$(p.bid) : '—'}</td><td class="neg">${p.ask != null ? $$(p.ask) : '—'}</td>
        <td>${sp}${sp !== '—' ? 'bps' : ''}</td><td class="${Math.abs(p.basis) > 0.05 ? 'risk-md' : 'dim'}">${p.basis.toFixed(4)}%</td>
        <td class="${p.funding != null ? (p.funding > 0 ? 'pos' : 'neg') : 'dim'}">${p.funding != null ? (p.funding * 100).toFixed(4) + '%' : '—'}</td>
        <td class="dim">${$n(Math.round(p.vol24h))}</td><td class="dim">${$n(Math.round(p.oi))}</td></tr>`; }).join('')}
    </tbody></table></div></div>`; });
  return h || `<div class="empty">No perp data</div>`;
}

// ═══════════════════════════════════════════════════════════════════
// TAB: CONFIG
// ═══════════════════════════════════════════════════════════════════
function rConf() {
  const { th, refreshMs } = G;
  const inp = (l, k, u, s = 1) => `<div class="th-row"><span class="th-l">${l}</span><input class="th-i" type="number" value="${th[k]}" step="${s}" min="0" onchange="sTh('${k}',+this.value)"/><span class="th-u">${u}</span></div>`;
  const proxiedHosts = Object.keys(needsProxy).filter(h => needsProxy[h]);
  return `${G.useProxy && proxiedHosts.length ? `<div class="prp-box">🔀 <b>CORS proxy active</b> for: ${proxiedHosts.join(', ')} — routed via corsproxy.io. Data is still live from the exchanges.</div>` : ''}
  <div class="grid g3">
    <div class="card"><div class="card-t" style="color:var(--acc);margin-bottom:8px">🔔 PT INTERNAL</div>
      ${inp('PT Wide Spread', 'ptSprd', '%')}${inp('PT vs Market Diff', 'ptVsMkt', '%')}${inp('Low Vol (% of avg)', 'lowVolPct', '%', 5)}</div>
    <div class="card"><div class="card-t" style="color:var(--prp);margin-bottom:8px">📊 CROSS-EXCHANGE</div>
      ${inp('IV Arb', 'ivArb', '%')}${inp('Perp Basis Diff', 'perpBps', 'bps')}${inp('Funding Diff', 'fundBps', 'bps')}</div>
    <div class="card"><div class="card-t" style="color:var(--cyn);margin-bottom:8px">⚡ PRESETS</div>
      <button class="preset" onclick="pre({ptSprd:5,ptVsMkt:8,ivArb:3,perpBps:2,fundBps:3,lowVolPct:10})">🔬 <b>Tight</b> — BTC/ETH liquid</button>
      <button class="preset" onclick="pre({ptSprd:15,ptVsMkt:20,ivArb:8,perpBps:5,fundBps:6,lowVolPct:10})">⚖️ <b>Normal</b> — illiquid (default)</button>
      <button class="preset" onclick="pre({ptSprd:30,ptVsMkt:40,ivArb:15,perpBps:10,fundBps:12,lowVolPct:5})">🎯 <b>Ultra-Wide</b> — extreme only</button></div>
    <div class="card"><div class="card-t" style="color:var(--org);margin-bottom:8px">🔌 CONNECTION</div>
      <div class="th-row"><span class="th-l">Auto-Refresh</span><input class="th-i" type="number" value="${refreshMs / 1000}" step="5" min="10" onchange="sR(+this.value*1000)"/><span class="th-u">sec</span></div>
      <div class="th-row" style="margin-top:4px"><span class="th-l">CORS Proxy Fallback</span>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" ${G.useProxy ? 'checked' : ''} onchange="G.useProxy=this.checked;Object.keys(needsProxy).forEach(k=>delete needsProxy[k]);refresh()"><span class="mono" style="font-size:9px;color:${G.useProxy ? 'var(--grn)' : 'var(--dim)'}">${G.useProxy ? 'ON' : 'OFF'}</span></label></div>
      <div style="margin-top:6px;font-family:var(--fm);font-size:8px;color:var(--dim);line-height:1.6">
        <b>How it works:</b> Tries direct first.<br>If CORS blocked → retries via corsproxy.io<br><br>
        <b>APIs (all public):</b><br>
        <span style="color:var(--acc);font-weight:700">★ PT:</span> api.rest.prod.power.trade<br>
        Deribit · OKX · Bybit</div></div>
    <div class="card"><div class="card-t" style="color:var(--org);margin-bottom:8px">💵 FEES</div>
      <div class="tbl-w"><table class="tbl"><thead><tr><th>Exchange</th><th>Maker</th><th>Taker</th></tr></thead><tbody>
      ${Object.entries(FEES).map(([e, f]) => `<tr><td style="${e === 'PT' ? 'color:var(--acc);font-weight:700' : ''}">${e}</td><td>${(f.m * 100).toFixed(2)}%</td><td>${(f.t * 100).toFixed(2)}%</td></tr>`).join('')}</tbody></table></div></div>
  </div>
  ${G.errors.length ? `<div class="card" style="margin-top:8px"><div class="card-t neg" style="margin-bottom:4px">⚠ ERRORS</div><div class="mono dim" style="font-size:8px;line-height:1.5">${G.errors.map(e => `• ${e}`).join('<br>')}</div></div>` : ''}`;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════════════════════════
function render() {
  const { tab, tick, live, loading, conn, spots, alerts, ptOpts, ptPerps, ptItems, mktOpts, lastUp } = G;
  const items = ptItems || [];
  const nc = alerts.filter(a => a.sev === 'critical').length, nw = alerts.filter(a => a.sev === 'warning').length, nAct = alerts.filter(a => a.profitable).length;
  const quoted = items.filter(o => o.status === 'QUOTED').length, problems = items.filter(o => o.status !== 'QUOTED').length, emptyN = items.filter(o => o.status === 'EMPTY').length;
  const fa = alerts.filter(a => (G.fAsset === 'ALL' || a.asset === G.fAsset) && (G.fCat === 'ALL' || a.cat === G.fCat) && (G.fSev === 'ALL' || a.sev === G.fSev) && (!G.fProf || a.profitable));
  const hp = items.length > 0 ? Math.round(quoted / items.length * 100) : 0;
  const hc = hp >= 70 ? 'var(--grn)' : hp >= 40 ? 'var(--org)' : 'var(--red)';
  const tabs = [{ id: 'health', l: '🏥 ORDERBOOK HEALTH' }, { id: 'alerts', l: '🚨 ALERTS', n: fa.length }, { id: 'compare', l: '⚖️ PT vs MARKET' }, { id: 'perps', l: '📊 PERPS' }, { id: 'config', l: '🎚 CONFIG' }];

  const ch = Object.entries(conn).map(([ex, c]) => { const isPT = ex === 'PT'; const px = c.proxied;
    return `<div class="conn ${c.ok ? px ? 'proxy' : 'ok' : (loading ? 'load' : 'err')}"><div class="dot" style="background:${c.ok ? px ? 'var(--prp)' : 'var(--grn)' : (loading ? 'var(--acc)' : 'var(--red)')};${c.ok ? 'box-shadow:0 0 4px ' + (px ? 'var(--prp)' : 'var(--grn)') : ''}"></div>
    <span style="color:${isPT && c.ok ? 'var(--acc)' : (c.ok ? (px ? 'var(--prp)' : 'var(--grn)') : (loading ? 'var(--acc)' : 'var(--red)'))};font-weight:${isPT ? '800' : '600'}">${ex}${isPT ? ' ★' : ''}</span>
    ${c.ok ? `<span class="dim">${c.n || 0}${px ? ' via proxy' : ''} · ${c.lat || 0}ms</span>` : (loading ? '<span class="spinner"></span>' : `<span class="dim">${c.err ? 'CORS?' : 'fail'}</span>`)}</div>`; }).join('');
  const sh = Object.entries(spots).map(([a, p]) => `<span class="spot-item">${a} <b style="color:var(--acc)">$${$n(p.toFixed(a === 'BTC' ? 1 : 2))}</b></span>`).join('');

  document.getElementById('app').innerHTML = `
  <div class="hdr"><div class="logo"><div class="logo-i">🚨</div><div><div class="logo-t">POWERTRADE POLICE</div><div class="logo-s">PT-CENTRIC · GITHUB PAGES · LIVE v3</div></div></div>
    <div class="hdr-r">${loading ? '<span class="spinner"></span>' : ''}
    <div class="dot" style="background:${live ? 'var(--grn)' : 'var(--dim)'}${live ? ';box-shadow:0 0 6px var(--grn);animation:pulse 2s infinite' : ''}"></div>
    <button class="btn" onclick="tL()">${live ? `LIVE ${G.refreshMs / 1000}s` : 'PAUSED'}</button>
    <button class="btn btn-a" onclick="refresh()">↻</button>
    <span class="mono dim" style="font-size:8px">#${tick} ${lastUp ? lastUp.toLocaleTimeString() : ''}</span></div></div>
  <div class="conn-bar">${ch}<span style="margin-left:auto" class="dim">${ptOpts.length} PT opts · ${mktOpts.length} mkt opts</span></div>
  ${sh ? `<div class="spot-bar">${sh}</div>` : ''}
  <div class="kpi-bar">
    <div class="kpi"><div class="kpi-l">PT Health</div><div class="kpi-v" style="color:${hc}">${hp}%</div><div class="kpi-s">${quoted}/${items.length}</div></div>
    <div class="kpi"><div class="kpi-l">Problems</div><div class="kpi-v" style="color:var(--red)">${problems}</div><div class="kpi-s">wide/empty/1-side</div></div>
    <div class="kpi"><div class="kpi-l">Empty</div><div class="kpi-v" style="color:var(--dim)">${emptyN}</div><div class="kpi-s">no quotes</div></div>
    <div class="kpi"><div class="kpi-l">Alerts</div><div class="kpi-v" style="color:var(--org)">${nc + nw}</div><div class="kpi-s">${nc}c / ${nw}w</div></div>
    <div class="kpi"><div class="kpi-l">Actionable</div><div class="kpi-v" style="color:var(--grn)">${nAct}</div></div>
  </div>
  <div class="tabs">${tabs.map(t => `<button class="tab${tab === t.id ? ' on' : ''}" onclick="sTab('${t.id}')">${t.l}${t.n != null ? `<span class="cnt">${t.n}</span>` : ''}</button>`).join('')}</div>
  <div class="main">${tab === 'health' ? rHealth() : tab === 'alerts' ? rAlerts() : tab === 'compare' ? rComp() : tab === 'perps' ? rPerps() : tab === 'config' ? rConf() : ''}</div>
  <div class="footer"><span>VIVI Risk Team · PowerTrade Police v3 · GitHub Pages</span>
    <span>${Object.keys(needsProxy).length ? ' CORS proxy active ·' : ''} ${lastUp ? lastUp.toISOString() : ''}</span></div>`;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT HANDLERS (global — called from onclick in rendered HTML)
// ═══════════════════════════════════════════════════════════════════
function sTab(t) { G.tab = t; render(); }
function sF(k, v) { G[k] = v; render(); }
function sTh(k, v) { G.th[k] = v; G.ptItems = analyzeHealth(G.ptOpts); G.alerts = detect(G.ptItems, G.ptPerps, G.mktOpts, G.mktPerps, G.th); render(); }
function pre(p) { G.th = p; G.ptItems = analyzeHealth(G.ptOpts); G.alerts = detect(G.ptItems, G.ptPerps, G.mktOpts, G.mktPerps, G.th); render(); }
function togA(id) { G.openA = G.openA === id ? null : id; render(); }
function tL() { G.live = !G.live; if (timer) clearInterval(timer); if (G.live) timer = setInterval(refresh, G.refreshMs); render(); }
function sR(ms) { G.refreshMs = Math.max(10000, ms); if (timer) clearInterval(timer); if (G.live) timer = setInterval(refresh, G.refreshMs); render(); }

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════
(async () => { await refresh(); if (G.live) timer = setInterval(refresh, G.refreshMs); })();
