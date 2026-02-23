#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// PowerTrade Police v5 — Alert Engine (GitHub Actions cron)
// Fetches all 5 exchanges, runs baseline detection, fires alerts
// to Slack and/or Telegram webhooks.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

// ── Config from environment ─────────────────────────────────────
const ENV = process.env.PT_ENV || 'testnet'; // 'testnet' or 'prod'
const PT_API = ENV === 'prod'
  ? 'https://api.rest.prod.power.trade'
  : 'https://api.rest.dev.power.trade';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const ALERT_MIN_CONFIDENCE = parseInt(process.env.ALERT_MIN_CONFIDENCE || '50');
const ONLY_CRITICAL = (process.env.ONLY_CRITICAL || 'false') === 'true';
const DRY_RUN = (process.env.DRY_RUN || 'false') === 'true';

// ── HTTP fetch helper ───────────────────────────────────────────
async function fj(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, data: await r.json(), lat: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: e.message, lat: Date.now() - t0 };
  }
}

// ── Black-Scholes (minimal for IV solving) ──────────────────────
const phi = x => { const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911,s=x<0?-1:1,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax),y=1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax);return .5*(1+s*y) };
const bsP = (S,K,T,r,v,cp) => { if(T<=1e-6||v<=1e-6)return Math.max(0,cp==='C'?S-K:K-S);const sq=Math.sqrt(T),d1=(Math.log(S/K)+(r+v*v/2)*T)/(v*sq),d2=d1-v*sq;return cp==='C'?S*phi(d1)-K*Math.exp(-r*T)*phi(d2):K*Math.exp(-r*T)*phi(-d2)-S*phi(-d1) };
const solveIV = (price,S,K,T,r,cp) => { if(T<=1e-6||price<=0||S<=0)return null;let v=.5,pDv=Infinity;for(let i=0;i<60;i++){const p=bsP(S,K,T,r,v,cp),d1=(Math.log(S/K)+(r+v*v/2)*T)/(v*Math.sqrt(T)),vg=S*Math.sqrt(T)*Math.exp(-d1*d1/2)/2.5066282746;if(vg<1e-10)break;const dv=(p-price)/vg;if(Math.abs(dv)>Math.abs(pDv)*2&&i>5)break;pDv=dv;v-=dv;if(v<=.001)v=.001;if(v>10)v=10;if(Math.abs(dv)<1e-8)break}return(v>.005&&v<9.9)?v:null };

// ── Exchange parsers ────────────────────────────────────────────
const MO = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
function dTE(d) { return Math.max(0, (d.getTime() - Date.now()) / 864e5) }

function parsePTOpt(sym) {
  const m = sym.match(/^(\w+)-(\d{8})-(\d+)(C|P)$/); if (!m) return null;
  const [,a,ds,k,cp] = m;
  const y=parseInt(ds.slice(0,4)),mo=parseInt(ds.slice(4,6))-1,d=parseInt(ds.slice(6,8));
  const MN=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return { asset:a, strike:parseInt(k), cp, expiry:`${d}${MN[mo]}${String(y).slice(2)}`, expiryDate:new Date(y,mo,d,8,0,0) };
}

function parseDI(n) {
  const m = n.match(/^(\w+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(C|P)$/); if (!m) return null;
  const [,a,day,mon,yr,k,cp] = m;
  const y=2000+parseInt(yr),mo=MO[mon]; if (mo===undefined) return null;
  return { asset:a, strike:parseInt(k), cp, expiry:`${day}${mon}${yr}`, expiryDate:new Date(y,mo,parseInt(day),8,0,0) };
}

function parseOI(n) {
  const m = n.match(/^(\w+)-USD-(\d{6})-(\d+)-(C|P)$/); if (!m) return null;
  const [,a,ds,k,cp] = m;
  const y=2000+parseInt(ds.slice(0,2)),mo=parseInt(ds.slice(2,4))-1,d=parseInt(ds.slice(4,6));
  const mn = Object.keys(MO).find(k=>MO[k]===mo) || '???';
  return { asset:a, strike:parseInt(k), cp, expiry:`${d}${mn}${ds.slice(0,2)}`, expiryDate:new Date(y,mo,d,8,0,0) };
}

function parseCCI(sym) {
  const m = sym.match(/^(\w+)USD-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(C|P)$/); if (!m) return null;
  const [,a,day,mon,yr,k,cp] = m;
  const y=2000+parseInt(yr),mo=MO[mon]; if (mo===undefined) return null;
  return { asset:a, strike:parseInt(k), cp, expiry:`${day}${mon}${yr}`, expiryDate:new Date(y,mo,parseInt(day),8,0,0) };
}

// ── Exchange fetchers ───────────────────────────────────────────
async function fetchPT() {
  const r = await fj(`${PT_API}/v1/market_data/tradeable_entity/all/summary`);
  if (!r.ok) return { opts:[], perps:[], spots:{}, ok:false };
  const opts=[], perps=[], spots={};
  for (const t of r.data) {
    const bid=t.best_bid?parseFloat(t.best_bid):null, ask=t.best_ask?parseFloat(t.best_ask):null;
    const last=t.last_price?parseFloat(t.last_price):null, idx=t.index_price?parseFloat(t.index_price):null;
    const vol=parseFloat(t.volume)||0, oi=parseFloat(t.open_interest)||0;
    if (t.product_type === 'option') {
      const p = parsePTOpt(t.symbol); if (!p) continue;
      const S=idx||0, mid=bid!=null&&ask!=null?(bid+ask)/2:(bid||ask||last||0);
      const sprd=bid!=null&&ask!=null&&mid>0?((ask-bid)/mid)*100:null;
      opts.push({ex:'PT',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,last,spot:S,sprd,vol24h:vol,oi,raw:t.symbol});
      if (S>0) spots[p.asset] = S;
    } else if (t.product_type === 'perpetual_future') {
      const asset=t.symbol.split('-')[0]; const mark=last||((bid||0)+(ask||0))/2;
      const funding=t.funding_rate?parseFloat(t.funding_rate):null;
      perps.push({ex:'PT',asset,isPerpetual:true,instrument:t.symbol,mark,bid,ask,spot:idx||0,funding,basis:idx>0?(mark-idx)/idx*100:0});
      if (idx>0) spots[asset] = idx;
    } else if (t.product_type === 'index') {
      const asset=t.symbol.split('-')[0]; if (idx>0) spots[asset] = idx;
    }
  }
  return { opts, perps, spots, ok:true };
}

async function fetchDeribit(asset) {
  const [oR,fR] = await Promise.all([
    fj(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=option`),
    fj(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=future`)]);
  const opts=[], perps=[];
  if (oR.ok && oR.data?.result) {
    for (const o of oR.data.result) {
      const p=parseDI(o.instrument_name); if (!p) continue;
      const S=o.underlying_price||0; if (!S) continue;
      const bid=(o.bid_price||0)*S, ask=(o.ask_price||0)*S, mark=(o.mark_price||0)*S;
      const mid=bid>0&&ask>0?(bid+ask)/2:mark;
      const sprd=mid>0&&bid>0&&ask>0?((ask-bid)/mid)*100:null;
      opts.push({ex:'Deribit',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:o.mark_iv?o.mark_iv/100:null,sprd,vol24h:o.volume||0,oi:o.open_interest||0,raw:o.instrument_name});
    }}
  if (fR.ok && fR.data?.result) {
    for (const f of fR.data.result) {
      const S=f.underlying_price||0; if (!S) continue;
      perps.push({ex:'Deribit',asset,isPerpetual:f.instrument_name.includes('PERPETUAL'),instrument:f.instrument_name,mark:f.mark_price||0,spot:S,funding:f.current_funding??null,basis:S>0?((f.mark_price||S)-S)/S*100:0});
    }}
  return { opts, perps, oOk:oR.ok, fOk:fR.ok };
}

async function fetchOKX(asset) {
  const [oR,sR,iR] = await Promise.all([
    fj(`https://www.okx.com/api/v5/market/tickers?instType=OPTION&instFamily=${asset}-USD`),
    fj(`https://www.okx.com/api/v5/market/tickers?instType=SWAP&instFamily=${asset}-USD`),
    fj(`https://www.okx.com/api/v5/market/index-tickers?instId=${asset}-USD`)]);
  const opts=[], perps=[]; let spot=0;
  if (iR.ok && iR.data?.data?.[0]) spot = parseFloat(iR.data.data[0].idxPx) || 0;
  if (oR.ok && oR.data?.data) {
    for (const o of oR.data.data) {
      const p=parseOI(o.instId); if (!p) continue; const S=spot; if (!S) continue;
      const bid=(parseFloat(o.bidPx)||0)*S, ask=(parseFloat(o.askPx)||0)*S;
      const mid=bid>0&&ask>0?(bid+ask)/2:0; const sprd=mid>0?((ask-bid)/mid)*100:null;
      opts.push({ex:'OKX',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:null,sprd,vol24h:parseFloat(o.volCcy24h)||0,oi:parseFloat(o.oi)||0,raw:o.instId});
    }}
  if (sR.ok && sR.data?.data) {
    for (const f of sR.data.data) {
      if (!f.instId.includes(asset)) continue;
      const mk=parseFloat(f.last)||0;
      perps.push({ex:'OKX',asset,isPerpetual:true,instrument:f.instId,mark:mk,spot,funding:f.fundingRate!=null?parseFloat(f.fundingRate):null,basis:spot>0?(mk-spot)/spot*100:0});
    }}
  return { opts, perps, oOk:oR.ok, fOk:sR.ok };
}

async function fetchBybit(asset) {
  const [oR,lR] = await Promise.all([
    fj(`https://api.bybit.com/v5/market/tickers?category=option&baseCoin=${asset}`),
    fj(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${asset}USDT`)]);
  const opts=[], perps=[];
  if (oR.ok && oR.data?.result?.list) {
    for (const o of oR.data.result.list) {
      const p=parseDI(o.symbol); if (!p) continue;
      const S=parseFloat(o.underlyingPrice)||0; if (!S) continue;
      const bid=parseFloat(o.bid1Price)||0, ask=parseFloat(o.ask1Price)||0, mark=parseFloat(o.markPrice)||0;
      const mid=bid>0&&ask>0?(bid+ask)/2:mark; const sprd=mid>0&&bid>0&&ask>0?((ask-bid)/mid)*100:null;
      opts.push({ex:'Bybit',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:o.markIv?parseFloat(o.markIv)/100:null,sprd,vol24h:parseFloat(o.volume24h)||0,oi:parseFloat(o.openInterest)||0,raw:o.symbol});
    }}
  if (lR.ok && lR.data?.result?.list) {
    for (const f of lR.data.result.list) {
      const mk=parseFloat(f.markPrice)||parseFloat(f.lastPrice)||0; const S=parseFloat(f.indexPrice)||mk;
      perps.push({ex:'Bybit',asset,isPerpetual:true,instrument:f.symbol,mark:mk,spot:S,funding:f.fundingRate!=null?parseFloat(f.fundingRate):null,basis:S>0?(mk-S)/S*100:0});
    }}
  return { opts, perps, oOk:oR.ok, fOk:lR.ok };
}

async function fetchCoinCall(asset) {
  const idx = asset + 'USD';
  const [oR,fR,frR] = await Promise.all([
    fj(`https://api.coincall.com/open/option/getOptionChain/v1/${idx}`),
    fj(`https://api.coincall.com/open/futures/market/getSymbolInfo/v1`),
    fj(`https://api.coincall.com/open/public/fundingRate/v1/${idx}`)]);
  const opts=[], perps=[]; let spot=0;
  if (oR.ok && oR.data?.data) {
    for (const row of oR.data.data) {
      for (const side of ['callOption','putOption']) {
        const o=row[side]; if (!o||!o.symbol) continue;
        const p=parseCCI(o.symbol); if (!p) continue;
        const S=o.underlyingPrice||0; if (!S) continue; if (S>0) spot=S;
        const bid=o.bid||0, ask=o.ask||0, mark=o.markPrice||0;
        const mid=bid>0&&ask>0?(bid+ask)/2:(mark||0);
        const sprd=mid>0&&bid>0&&ask>0?((ask-bid)/mid)*100:null;
        opts.push({ex:'CoinCall',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:o.markIv?o.markIv/100:null,sprd,vol24h:o.volume||0,oi:o.openInterest||0,raw:o.symbol});
      }}}
  if (fR.ok && fR.data?.data) {
    for (const f of fR.data.data) {
      if (f.symbol !== idx) continue;
      const mk=parseFloat(f.markPrice)||parseFloat(f.price)||0;
      const S=parseFloat(f.indexPrice)||mk; if (S>0) spot=S;
      const funding = frR.ok&&frR.data?.data?.fundingRate!=null ? parseFloat(frR.data.data.fundingRate) : null;
      perps.push({ex:'CoinCall',asset,isPerpetual:true,instrument:f.displayName||`${asset}-PERP`,mark:mk,spot:S,funding,basis:S>0?(mk-S)/S*100:0});
    }}
  return { opts, perps, oOk:oR.ok, fOk:fR.ok, spot };
}

// ── Baseline system ─────────────────────────────────────────────
const FEES = {PT:{m:.0003,t:.0005},Deribit:{m:.0002,t:.0003},OKX:{m:.0002,t:.0003},Bybit:{m:.0002,t:.0004},CoinCall:{m:.0003,t:.0004}};
const SLIP = 0.005;
const TH = { ptVsMkt:20, ivArb:8, perpBps:5, fundBps:6, minExtVol:50000, minExtOI:5, blWarn:1.5, blCrit:3.0 };

function getBands(o) {
  const S=o.spot||0; const mono=S>0?Math.abs(o.strike-S)/S:0.5;
  const monoBand = mono<.05?'ATM':mono<.15?'NEAR':'DEEP';
  const dte = o.T*365;
  const dteBand = dte<1?'0D':dte<3?'1-3D':dte<7?'3-7D':dte<30?'7-30D':dte<90?'30-90D':'90D+';
  return { key:`${o.asset}-${monoBand}-${dteBand}` };
}

function buildBaseline(ptItems) {
  const bl = { timestamp:Date.now(), buckets:{}, options:{}, quotedCount:0, totalCount:ptItems.length };
  for (const o of ptItems) {
    const {key} = getBands(o);
    if (!bl.buckets[key]) bl.buckets[key] = { spreads:[], quoted:0, total:0 };
    const b = bl.buckets[key]; b.total++;
    if (o.status==='QUOTED') { b.quoted++; b.spreads.push(o.sprd); }
  }
  for (const b of Object.values(bl.buckets)) {
    b.spreads.sort((a,c) => a-c);
    b.p95 = b.spreads[Math.floor(b.spreads.length*0.95)] || null;
    b.median = b.spreads[Math.floor(b.spreads.length/2)] || null;
  }
  for (const o of ptItems) {
    bl.options[o.raw] = { status:o.status, sprd:o.sprd, mid:o.mid };
    if (o.status==='QUOTED' || o.status==='WIDE') bl.quotedCount++;
  }
  return bl;
}

function dynSprdTh(o, baseline) {
  if (!baseline) { // fallback
    const S=o.spot||0; const mono=S>0?Math.abs(o.strike-S)/S:.2; const dte=o.T*365;
    if(dte<1)return 60;if(dte<3)return 45;if(dte<7)return mono<.05?10:mono<.15?18:38;
    return mono<.05?12:mono<.15?20:35;
  }
  const {key} = getBands(o); const b = baseline.buckets[key];
  if (!b || !b.p95) return 50;
  return b.p95 * TH.blWarn;
}

// ── Analysis + detection ────────────────────────────────────────
function analyzeHealth(ptOpts, baseline) {
  return ptOpts.map(o => {
    const hasBid=o.bid!=null&&o.bid>0, hasAsk=o.ask!=null&&o.ask>0;
    const th = dynSprdTh(o, baseline);
    let status = 'EMPTY';
    if (hasBid&&hasAsk) status = o.sprd!=null&&o.sprd>=th ? 'WIDE' : 'QUOTED';
    else if (hasBid||hasAsk) status = 'ONE_SIDED';
    let iv = null;
    if (o.mid>0 && o.spot>0 && o.T>1e-6) iv = solveIV(o.mid,o.spot,o.strike,o.T,0,o.cp);
    // Baseline deviation
    let blDev = null;
    if (baseline) {
      const bo = baseline.options[o.raw];
      if (bo) {
        const wasQ = bo.status==='QUOTED' || bo.status==='WIDE';
        if (wasQ && (status==='EMPTY'||status==='ONE_SIDED')) blDev = 'PULLED';
        else if (wasQ && o.sprd!=null && bo.sprd>0) {
          const ratio = o.sprd / bo.sprd;
          if (ratio > TH.blCrit) blDev = 'BLOWN';
          else if (ratio > TH.blWarn) blDev = 'DRIFTED';
        }
      }
    }
    return { ...o, status, iv, th, blDev };
  });
}

function detect(ptItems, ptPerps, mktOpts, mktPerps, baseline) {
  const al = [];
  const isLiquid = m => m.bid>0 && m.ask>0 && m.vol24h>=TH.minExtVol && m.oi>=TH.minExtOI;

  // PT internal — baseline deviations
  for (const o of ptItems) {
    // Suppress: never quoted at baseline
    if (baseline && ['PT_WIDE','PT_STALE'].some(c => true)) {
      const bo = baseline.options[o.raw];
      if (!bo || bo.status==='EMPTY') continue;
    }
    if (o.blDev === 'PULLED') {
      al.push({ cat:'PT_STALE', sev:'critical', asset:o.asset, title:o.raw, confidence:85,
        msg:`QUOTE PULLED — was live at baseline, now ${o.status}` });
    } else if (o.blDev === 'BLOWN') {
      const blSprd = baseline?.options[o.raw]?.sprd || 0;
      al.push({ cat:'PT_WIDE', sev:'critical', asset:o.asset, title:o.raw, confidence:75,
        msg:`Spread BLOWN ${o.sprd?.toFixed(1)}% (baseline ${blSprd.toFixed(1)}%, ${(o.sprd/blSprd).toFixed(1)}x)` });
    } else if (o.blDev === 'DRIFTED') {
      const blSprd = baseline?.options[o.raw]?.sprd || 0;
      al.push({ cat:'PT_WIDE', sev:'warning', asset:o.asset, title:o.raw, confidence:50,
        msg:`Spread drifted ${o.sprd?.toFixed(1)}% (baseline ${blSprd.toFixed(1)}%, ${(o.sprd/blSprd).toFixed(1)}x)` });
    }
    // Near-expiry
    const hrs = o.T*365*24;
    if (hrs>0 && hrs<=24 && o.status!=='EMPTY') {
      al.push({ cat:'PT_STALE', sev:'critical', asset:o.asset, title:`⏱ ${o.raw}`, confidence:90,
        msg:`EXPIRING IN ${hrs.toFixed(1)}h — OI: ${o.oi}` });
    }
  }

  // PT vs Market — executable arb + IV dislocation
  const mktByK = {};
  for (const o of mktOpts) { if (o.T<2/365||o.mid<=0) continue; const k=`${o.asset}-${o.strike}-${o.expiry}-${o.cp}`; if(!mktByK[k])mktByK[k]=[]; mktByK[k].push(o); }
  for (const pt of ptItems) {
    if (pt.mid<=0 || pt.T<2/365 || pt.mid<1) continue;
    const k = `${pt.asset}-${pt.strike}-${pt.expiry}-${pt.cp}`;
    const mkts = mktByK[k]; if (!mkts) continue;
    const liq = mkts.filter(isLiquid); if (!liq.length) continue;
    // IV dislocation
    if (pt.iv) {
      for (const m of liq) {
        const mktIv = m.markIv; if (!mktIv) continue;
        const ivDiff = (pt.iv - mktIv) * 100;
        if (Math.abs(ivDiff) >= TH.ivArb) {
          al.push({ cat:'MKT_IV', sev:Math.abs(ivDiff)>=TH.ivArb*2?'critical':'warning', asset:pt.asset, title:pt.raw, confidence:60,
            msg:`PT IV ${(pt.iv*100).toFixed(1)}% vs ${m.ex} IV ${(mktIv*100).toFixed(1)}% (Δ${ivDiff.toFixed(1)} vol pts)` });
        }
      }
    }
    // Executable arb
    const mktMids = liq.map(m=>m.mid); const mktAvg = mktMids.reduce((a,b)=>a+b,0)/mktMids.length;
    const pctDiff = ((pt.mid-mktAvg)/mktAvg)*100;
    if (Math.abs(pctDiff) < TH.ptVsMkt) continue;
    const cheap = pctDiff < 0;
    if (cheap && pt.ask>0) {
      const bestBid = liq.reduce((b,m)=>m.bid>(b?.bid||0)?m:b, null);
      if (bestBid?.bid>0) {
        const gross = bestBid.bid*(1-SLIP) - pt.ask*(1+SLIP);
        const fees = pt.ask*FEES.PT.t + bestBid.bid*(FEES[bestBid.ex]?.t||.0005);
        const net = gross - fees;
        al.push({ cat:'PT_CHEAP', sev:Math.abs(pctDiff)>=TH.ptVsMkt*2?'critical':'warning', asset:pt.asset, title:pt.raw, confidence:65, profitable:net>0, net,
          msg:`PT $${pt.mid.toFixed(2)} vs mkt $${mktAvg.toFixed(2)} (${pctDiff.toFixed(1)}%) — BUY @${pt.ask.toFixed(2)} SELL ${bestBid.ex} @${bestBid.bid.toFixed(2)} [net $${net.toFixed(2)}]` });
      }
    } else if (!cheap && pt.bid>0) {
      const bestAsk = liq.filter(m=>m.ask>0).reduce((b,m)=>!b||m.ask<b.ask?m:b, null);
      if (bestAsk?.ask>0) {
        const gross = pt.bid*(1-SLIP) - bestAsk.ask*(1+SLIP);
        const fees = pt.bid*FEES.PT.t + bestAsk.ask*(FEES[bestAsk.ex]?.t||.0005);
        const net = gross - fees;
        al.push({ cat:'PT_RICH', sev:Math.abs(pctDiff)>=TH.ptVsMkt*2?'critical':'warning', asset:pt.asset, title:pt.raw, confidence:65, profitable:net>0, net,
          msg:`PT $${pt.mid.toFixed(2)} vs mkt $${mktAvg.toFixed(2)} (+${pctDiff.toFixed(1)}%) — SELL @${pt.bid.toFixed(2)} BUY ${bestAsk.ex} @${bestAsk.ask.toFixed(2)} [net $${net.toFixed(2)}]` });
      }
    }
  }

  // Perp basis + funding arb
  const pBA = {};
  for (const p of [...ptPerps,...mktPerps]) { if(!p.isPerpetual)continue; if(!pBA[p.asset])pBA[p.asset]={}; pBA[p.asset][p.ex]=p; }
  for (const [asset,em] of Object.entries(pBA)) {
    const pt=em.PT; if (!pt) continue;
    for (const [ex,mp] of Object.entries(em)) {
      if (ex==='PT') continue;
      const bdBps = Math.abs(pt.basis-mp.basis)*100;
      if (bdBps >= TH.perpBps) {
        const net = Math.abs(pt.mark-mp.mark) - (pt.mark+mp.mark)/2*(FEES.PT.t+(FEES[ex]?.t||.0005));
        al.push({ cat:'PERP_ARB', sev:bdBps>TH.perpBps*2?'critical':'warning', asset, title:`${asset} PERP PT↔${ex}`, confidence:70, profitable:net>0, net,
          msg:`Basis Δ ${bdBps.toFixed(1)}bps | PT $${pt.mark.toFixed(2)} vs ${ex} $${mp.mark.toFixed(2)} [net $${net.toFixed(2)}]` });
      }
      if (pt.funding!=null && mp.funding!=null) {
        const fdBps = Math.abs(pt.funding-mp.funding)*10000;
        if (fdBps >= TH.fundBps) {
          al.push({ cat:'FUND_ARB', sev:fdBps>TH.fundBps*2?'critical':'warning', asset, title:`${asset} FUNDING PT↔${ex}`, confidence:60, profitable:fdBps>3,
            msg:`Funding Δ ${fdBps.toFixed(2)}bps | PT ${(pt.funding*10000).toFixed(2)}bps vs ${ex} ${(mp.funding*10000).toFixed(2)}bps` });
        }
      }
    }
  }

  return al.filter(a => a.confidence >= ALERT_MIN_CONFIDENCE)
    .sort((a,b) => (a.sev==='critical'?0:1)-(b.sev==='critical'?0:1) || (b.confidence||0)-(a.confidence||0));
}

// ── Alert dispatchers ───────────────────────────────────────────
const CAT_EMOJI = { PT_WIDE:'📏', PT_STALE:'⏱', PT_CHEAP:'🟢', PT_RICH:'🔴', MKT_IV:'📊', PERP_ARB:'⚡', FUND_ARB:'💰' };

async function sendSlack(alerts, summary) {
  if (!SLACK_WEBHOOK) return;
  const blocks = [
    { type:'header', text:{ type:'plain_text', text:`🚨 PT Police [${ENV.toUpperCase()}] — ${alerts.length} alert${alerts.length!==1?'s':''}`} },
    { type:'section', text:{ type:'mrkdwn', text:summary } },
    { type:'divider' }
  ];
  for (const a of alerts.slice(0, 15)) {
    const emoji = CAT_EMOJI[a.cat] || '⚠';
    const sev = a.sev === 'critical' ? '🔴' : '🟡';
    blocks.push({ type:'section', text:{ type:'mrkdwn',
      text:`${sev} ${emoji} *[${a.cat}] ${a.asset}* — \`${a.title}\`\n${a.msg}${a.profitable ? '\n✅ *ACTIONABLE*' : ''}` }});
  }
  if (alerts.length > 15) blocks.push({ type:'section', text:{ type:'mrkdwn', text:`_...and ${alerts.length-15} more_` }});

  const r = await fetch(SLACK_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({blocks}) });
  console.log(`Slack: ${r.status} ${r.statusText}`);
}

async function sendTelegram(alerts, summary) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  let text = `🚨 <b>PT Police [${ENV.toUpperCase()}] — ${alerts.length} alert${alerts.length!==1?'s':''}</b>\n${summary}\n\n`;
  for (const a of alerts.slice(0, 20)) {
    const emoji = CAT_EMOJI[a.cat] || '⚠';
    const sev = a.sev === 'critical' ? '🔴' : '🟡';
    text += `${sev} ${emoji} <b>[${a.cat}] ${a.asset}</b> — <code>${a.title}</code>\n${a.msg}${a.profitable ? '\n✅ ACTIONABLE' : ''}\n\n`;
  }
  if (alerts.length > 20) text += `<i>...and ${alerts.length-20} more</i>`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true }) });
  const rj = await r.json();
  console.log(`Telegram: ${rj.ok ? 'sent' : rj.description}`);
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══ PT Police Alert Engine [${ENV.toUpperCase()}] — ${new Date().toISOString()} ═══\n`);
  console.log(`PT API: ${PT_API}`);

  // Load baseline
  let baseline = null;
  if (fs.existsSync(BASELINE_PATH)) {
    try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
      const ageH = (Date.now() - baseline.timestamp) / 3600000;
      console.log(`Loaded baseline: ${baseline.quotedCount} options, ${ageH.toFixed(1)}h old`);
      if (ageH > 12) { console.log('Baseline >12h old — will recapture'); baseline = null; }
    } catch(e) { console.log('Failed to load baseline:', e.message); }
  }

  // Fetch all exchanges
  console.log('Fetching PT + Deribit + OKX + Bybit + CoinCall...');
  const [ptR, ...mktRs] = await Promise.allSettled([
    fetchPT(),
    fetchDeribit('BTC'), fetchDeribit('ETH'), fetchDeribit('SOL'),
    fetchOKX('BTC'), fetchOKX('ETH'),
    fetchBybit('BTC'), fetchBybit('ETH'), fetchBybit('SOL'),
    fetchCoinCall('BTC'), fetchCoinCall('ETH'), fetchCoinCall('SOL')
  ]);

  if (ptR.status !== 'fulfilled' || !ptR.value?.ok) {
    console.error('PT fetch failed — aborting'); process.exit(1);
  }
  const pt = ptR.value;
  console.log(`PT: ${pt.opts.length} opts, ${pt.perps.length} perps`);

  let mktOpts = [], mktPerps = [];
  const exNames = ['Deribit','Deribit','Deribit','OKX','OKX','Bybit','Bybit','Bybit','CoinCall','CoinCall','CoinCall'];
  mktRs.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      if (r.value.oOk) mktOpts = mktOpts.concat(r.value.opts);
      if (r.value.fOk) mktPerps = mktPerps.concat(r.value.perps);
    } else { console.log(`${exNames[i]} fetch failed`); }
  });
  console.log(`Market: ${mktOpts.length} opts, ${mktPerps.length} perps`);

  // Analyze health
  const ptItems = analyzeHealth(pt.opts, baseline);

  // Capture/update baseline if needed
  if (!baseline) {
    console.log('Capturing new baseline...');
    baseline = buildBaseline(ptItems);
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline));
    console.log(`Baseline saved: ${baseline.quotedCount} quoted / ${baseline.totalCount} total`);
    // Re-analyze with new baseline
    const ptItems2 = analyzeHealth(pt.opts, baseline);
    Object.assign(ptItems, ptItems2);
  }

  // Detect alerts
  const alerts = detect(ptItems, pt.perps, mktOpts, mktPerps, baseline);
  const crit = alerts.filter(a => a.sev === 'critical');
  const warn = alerts.filter(a => a.sev === 'warning');
  const actionable = alerts.filter(a => a.profitable);

  console.log(`\nAlerts: ${crit.length} critical, ${warn.length} warning, ${actionable.length} actionable`);

  // Build summary
  const spots = Object.entries(pt.spots).map(([a,p]) => `${a} $${p.toFixed(0)}`).join(' · ');
  const blAge = ((Date.now() - baseline.timestamp) / 3600000).toFixed(1);
  const summary = `${spots} | ${pt.opts.length} PT opts | Baseline: ${blAge}h old | ${crit.length} crit · ${warn.length} warn · ${actionable.length} actionable`;

  // Filter for dispatch
  const toSend = ONLY_CRITICAL ? crit : alerts;
  if (toSend.length === 0) { console.log('No alerts to dispatch.'); return; }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN (not sending) ---');
    for (const a of toSend.slice(0, 20)) console.log(`  ${a.sev==='critical'?'🔴':'🟡'} [${a.cat}] ${a.asset} — ${a.title}: ${a.msg}`);
    return;
  }

  // Dispatch
  await Promise.allSettled([sendSlack(toSend, summary), sendTelegram(toSend, summary)]);
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
