#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// PowerTrade Police v5.1 — Alert Engine (GitHub Actions cron)
//
// Philosophy: only send alerts that require human action.
//   - Group related issues into single messages
//   - Filter by materiality (OI, volume, moneyness)
//   - Tiered: 🔴 URGENT (act now) vs 🟡 WATCH (awareness)
//   - Concise: one screen on a phone, max
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';
const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const DRY_RUN = (process.env.DRY_RUN || 'false') === 'true';

// What matters — tune these
const CFG = {
  // Only alert on options with real exposure
  minOI: 1,                 // minimum open interest to care about
  minVol24h: 100,           // minimum 24h volume to care about
  // Expiry alerts
  expiryAlertH: 4,          // only alert if <4h to expiry
  expiryMinOI: 1,           // AND has open interest
  // Quote pulled — only ATM/near-money with OI
  pullMoneyness: 0.10,      // within 10% of spot = material
  pullMinOI: 0,             // any OI counts (quoter should quote it)
  // Spread blown — only if someone might trade it
  blownMinOI: 0,            // any OI
  // Cross-exchange arb
  minArbNet: 5,             // minimum $5 net edge to alert
  ptVsMkt: 20,              // % diff threshold
  ivArb: 8,                 // vol pts
  perpBps: 5,               // basis points
  fundBps: 6,               // basis points
  minExtVol: 50000,         // external liquidity filter
  minExtOI: 5,
  // Baseline
  blWarn: 1.5,
  blCrit: 3.0,
  blMaxAgeH: 12,            // recapture if older than this
  // Quoter health — alert if drops below
  healthCritical: 50,       // 🔴 below 50% = quoter is down
  healthWarning: 70,        // 🟡 below 70% = quoter degraded
};

// ── HTTP + math helpers ─────────────────────────────────────────
async function fj(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok:true, data:await r.json(), lat:Date.now()-t0 };
  } catch(e) { return { ok:false, err:e.message, lat:Date.now()-t0 }; }
}
function dTE(d) { return Math.max(0, (d.getTime()-Date.now()) / 864e5); }
const phi=x=>{const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911,s=x<0?-1:1,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax),y=1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax);return .5*(1+s*y)};
const bsP=(S,K,T,r,v,cp)=>{if(T<=1e-6||v<=1e-6)return Math.max(0,cp==='C'?S-K:K-S);const sq=Math.sqrt(T),d1=(Math.log(S/K)+(r+v*v/2)*T)/(v*sq),d2=d1-v*sq;return cp==='C'?S*phi(d1)-K*Math.exp(-r*T)*phi(d2):K*Math.exp(-r*T)*phi(-d2)-S*phi(-d1)};
const solveIV=(price,S,K,T,r,cp)=>{if(T<=1e-6||price<=0||S<=0)return null;let v=.5,pDv=Infinity;for(let i=0;i<60;i++){const p=bsP(S,K,T,r,v,cp),d1=(Math.log(S/K)+(r+v*v/2)*T)/(v*Math.sqrt(T)),vg=S*Math.sqrt(T)*Math.exp(-d1*d1/2)/2.5066282746;if(vg<1e-10)break;const dv=(p-price)/vg;if(Math.abs(dv)>Math.abs(pDv)*2&&i>5)break;pDv=dv;v-=dv;if(v<=.001)v=.001;if(v>10)v=10;if(Math.abs(dv)<1e-8)break}return(v>.005&&v<9.9)?v:null};

// ── Exchange parsers (same as v5) ───────────────────────────────
const MO={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
function parsePTOpt(sym){const m=sym.match(/^(\w+)-(\d{8})-(\d+)(C|P)$/);if(!m)return null;const[,a,ds,k,cp]=m;const y=parseInt(ds.slice(0,4)),mo=parseInt(ds.slice(4,6))-1,d=parseInt(ds.slice(6,8));const MN=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];return{asset:a,strike:parseInt(k),cp,expiry:`${d}${MN[mo]}${String(y).slice(2)}`,expiryDate:new Date(y,mo,d,8,0,0)}}
function parseDI(n){const m=n.match(/^(\w+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(C|P)$/);if(!m)return null;const[,a,day,mon,yr,k,cp]=m;const y=2000+parseInt(yr),mo=MO[mon];if(mo===undefined)return null;return{asset:a,strike:parseInt(k),cp,expiry:`${day}${mon}${yr}`,expiryDate:new Date(y,mo,parseInt(day),8,0,0)}}
function parseOI(n){const m=n.match(/^(\w+)-USD-(\d{6})-(\d+)-(C|P)$/);if(!m)return null;const[,a,ds,k,cp]=m;const y=2000+parseInt(ds.slice(0,2)),mo=parseInt(ds.slice(2,4))-1,d=parseInt(ds.slice(4,6));const mn=Object.keys(MO).find(k=>MO[k]===mo)||'???';return{asset:a,strike:parseInt(k),cp,expiry:`${d}${mn}${ds.slice(0,2)}`,expiryDate:new Date(y,mo,d,8,0,0)}}
function parseCCI(sym){const m=sym.match(/^(\w+)USD-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(C|P)$/);if(!m)return null;const[,a,day,mon,yr,k,cp]=m;const y=2000+parseInt(yr),mo=MO[mon];if(mo===undefined)return null;return{asset:a,strike:parseInt(k),cp,expiry:`${day}${mon}${yr}`,expiryDate:new Date(y,mo,parseInt(day),8,0,0)}}

// ── Exchange fetchers ───────────────────────────────────────────
async function fetchPT(){
  const r=await fj('https://api.rest.prod.power.trade/v1/market_data/tradeable_entity/all/summary');
  if(!r.ok)return{opts:[],perps:[],spots:{},ok:false};
  const opts=[],perps=[],spots={};
  for(const t of r.data){
    const bid=t.best_bid?parseFloat(t.best_bid):null,ask=t.best_ask?parseFloat(t.best_ask):null;
    const last=t.last_price?parseFloat(t.last_price):null,idx=t.index_price?parseFloat(t.index_price):null;
    const vol=parseFloat(t.volume)||0,oi=parseFloat(t.open_interest)||0;
    if(t.product_type==='option'){
      const p=parsePTOpt(t.symbol);if(!p)continue;
      const S=idx||0,mid=bid!=null&&ask!=null?(bid+ask)/2:(bid||ask||last||0);
      const sprd=bid!=null&&ask!=null&&mid>0?((ask-bid)/mid)*100:null;
      opts.push({ex:'PT',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,last,spot:S,sprd,vol24h:vol,oi,raw:t.symbol});
      if(S>0)spots[p.asset]=S;
    }else if(t.product_type==='perpetual_future'){
      const asset=t.symbol.split('-')[0];const mark=last||((bid||0)+(ask||0))/2;
      const funding=t.funding_rate?parseFloat(t.funding_rate):null;
      perps.push({ex:'PT',asset,isPerpetual:true,instrument:t.symbol,mark,bid,ask,spot:idx||0,funding,basis:idx>0?(mark-idx)/idx*100:0});
      if(idx>0)spots[asset]=idx;
    }else if(t.product_type==='index'){
      const asset=t.symbol.split('-')[0];if(idx>0)spots[asset]=idx;
    }}
  return{opts,perps,spots,ok:true}}

async function fetchDeribit(asset){
  const[oR,fR]=await Promise.all([fj(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=option`),fj(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=future`)]);
  const opts=[],perps=[];
  if(oR.ok&&oR.data?.result){for(const o of oR.data.result){const p=parseDI(o.instrument_name);if(!p)continue;const S=o.underlying_price||0;if(!S)continue;const bid=(o.bid_price||0)*S,ask=(o.ask_price||0)*S,mark=(o.mark_price||0)*S;const mid=bid>0&&ask>0?(bid+ask)/2:mark;const sprd=mid>0&&bid>0&&ask>0?((ask-bid)/mid)*100:null;opts.push({ex:'Deribit',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:o.mark_iv?o.mark_iv/100:null,sprd,vol24h:o.volume||0,oi:o.open_interest||0,raw:o.instrument_name})}}
  if(fR.ok&&fR.data?.result){for(const f of fR.data.result){const S=f.underlying_price||0;if(!S)continue;perps.push({ex:'Deribit',asset,isPerpetual:f.instrument_name.includes('PERPETUAL'),instrument:f.instrument_name,mark:f.mark_price||0,spot:S,funding:f.current_funding??null,basis:S>0?((f.mark_price||S)-S)/S*100:0})}}
  return{opts,perps,oOk:oR.ok,fOk:fR.ok}}

async function fetchOKX(asset){
  const[oR,sR,iR]=await Promise.all([fj(`https://www.okx.com/api/v5/market/tickers?instType=OPTION&instFamily=${asset}-USD`),fj(`https://www.okx.com/api/v5/market/tickers?instType=SWAP&instFamily=${asset}-USD`),fj(`https://www.okx.com/api/v5/market/index-tickers?instId=${asset}-USD`)]);
  const opts=[],perps=[];let spot=0;
  if(iR.ok&&iR.data?.data?.[0])spot=parseFloat(iR.data.data[0].idxPx)||0;
  if(oR.ok&&oR.data?.data){for(const o of oR.data.data){const p=parseOI(o.instId);if(!p)continue;const S=spot;if(!S)continue;const bid=(parseFloat(o.bidPx)||0)*S,ask=(parseFloat(o.askPx)||0)*S;const mid=bid>0&&ask>0?(bid+ask)/2:0;const sprd=mid>0?((ask-bid)/mid)*100:null;opts.push({ex:'OKX',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:null,sprd,vol24h:parseFloat(o.volCcy24h)||0,oi:parseFloat(o.oi)||0,raw:o.instId})}}
  if(sR.ok&&sR.data?.data){for(const f of sR.data.data){if(!f.instId.includes(asset))continue;const mk=parseFloat(f.last)||0;perps.push({ex:'OKX',asset,isPerpetual:true,instrument:f.instId,mark:mk,spot,funding:f.fundingRate!=null?parseFloat(f.fundingRate):null,basis:spot>0?(mk-spot)/spot*100:0})}}
  return{opts,perps,oOk:oR.ok,fOk:sR.ok}}

async function fetchBybit(asset){
  const[oR,lR]=await Promise.all([fj(`https://api.bybit.com/v5/market/tickers?category=option&baseCoin=${asset}`),fj(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${asset}USDT`)]);
  const opts=[],perps=[];
  if(oR.ok&&oR.data?.result?.list){for(const o of oR.data.result.list){const p=parseDI(o.symbol);if(!p)continue;const S=parseFloat(o.underlyingPrice)||0;if(!S)continue;const bid=parseFloat(o.bid1Price)||0,ask=parseFloat(o.ask1Price)||0,mark=parseFloat(o.markPrice)||0;const mid=bid>0&&ask>0?(bid+ask)/2:mark;const sprd=mid>0&&bid>0&&ask>0?((ask-bid)/mid)*100:null;opts.push({ex:'Bybit',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:o.markIv?parseFloat(o.markIv)/100:null,sprd,vol24h:parseFloat(o.volume24h)||0,oi:parseFloat(o.openInterest)||0,raw:o.symbol})}}
  if(lR.ok&&lR.data?.result?.list){for(const f of lR.data.result.list){const mk=parseFloat(f.markPrice)||parseFloat(f.lastPrice)||0;const S=parseFloat(f.indexPrice)||mk;perps.push({ex:'Bybit',asset,isPerpetual:true,instrument:f.symbol,mark:mk,spot:S,funding:f.fundingRate!=null?parseFloat(f.fundingRate):null,basis:S>0?(mk-S)/S*100:0})}}
  return{opts,perps,oOk:oR.ok,fOk:lR.ok}}

async function fetchCoinCall(asset){
  const idx=asset+'USD';
  const[oR,fR,frR]=await Promise.all([fj(`https://api.coincall.com/open/option/getOptionChain/v1/${idx}`),fj(`https://api.coincall.com/open/futures/market/getSymbolInfo/v1`),fj(`https://api.coincall.com/open/public/fundingRate/v1/${idx}`)]);
  const opts=[],perps=[];let spot=0;
  if(oR.ok&&oR.data?.data){for(const row of oR.data.data){for(const side of['callOption','putOption']){const o=row[side];if(!o||!o.symbol)continue;const p=parseCCI(o.symbol);if(!p)continue;const S=o.underlyingPrice||0;if(!S)continue;if(S>0)spot=S;const bid=o.bid||0,ask=o.ask||0,mark=o.markPrice||0;const mid=bid>0&&ask>0?(bid+ask)/2:(mark||0);const sprd=mid>0&&bid>0&&ask>0?((ask-bid)/mid)*100:null;opts.push({ex:'CoinCall',asset:p.asset,strike:p.strike,expiry:p.expiry,expiryDate:p.expiryDate,cp:p.cp,T:dTE(p.expiryDate)/365,bid,ask,mid,spot:S,markIv:o.markIv?o.markIv/100:null,sprd,vol24h:o.volume||0,oi:o.openInterest||0,raw:o.symbol})}}}
  if(fR.ok&&fR.data?.data){for(const f of fR.data.data){if(f.symbol!==idx)continue;const mk=parseFloat(f.markPrice)||parseFloat(f.price)||0;const S=parseFloat(f.indexPrice)||mk;if(S>0)spot=S;const funding=frR.ok&&frR.data?.data?.fundingRate!=null?parseFloat(frR.data.data.fundingRate):null;perps.push({ex:'CoinCall',asset,isPerpetual:true,instrument:f.displayName||`${asset}-PERP`,mark:mk,spot:S,funding,basis:S>0?(mk-S)/S*100:0})}}
  return{opts,perps,oOk:oR.ok,fOk:fR.ok,spot}}

// ── Baseline ────────────────────────────────────────────────────
const FEES={PT:{m:.0003,t:.0005},Deribit:{m:.0002,t:.0003},OKX:{m:.0002,t:.0003},Bybit:{m:.0002,t:.0004},CoinCall:{m:.0003,t:.0004}};
const SLIP=0.005;

function getBands(o){
  const S=o.spot||0;const mono=S>0?Math.abs(o.strike-S)/S:0.5;
  return{key:`${o.asset}-${mono<.05?'ATM':mono<.15?'NEAR':'DEEP'}-${o.T*365<1?'0D':o.T*365<7?'1-7D':o.T*365<30?'7-30D':'30D+'}`}}

function buildBaseline(items){
  const bl={timestamp:Date.now(),buckets:{},options:{},quotedCount:0,totalCount:items.length};
  for(const o of items){
    const{key}=getBands(o);if(!bl.buckets[key])bl.buckets[key]={spreads:[],quoted:0,total:0};
    const b=bl.buckets[key];b.total++;
    if(o.status==='QUOTED'){b.quoted++;b.spreads.push(o.sprd)}}
  for(const b of Object.values(bl.buckets)){
    b.spreads.sort((a,c)=>a-c);b.p95=b.spreads[Math.floor(b.spreads.length*0.95)]||null}
  for(const o of items){
    bl.options[o.raw]={status:o.status,sprd:o.sprd,mid:o.mid};
    if(o.status==='QUOTED'||o.status==='WIDE')bl.quotedCount++}
  return bl}

function dynSprdTh(o,bl){
  if(!bl){const S=o.spot||0;const m=S>0?Math.abs(o.strike-S)/S:.2;const d=o.T*365;if(d<1)return 60;if(d<7)return m<.05?12:m<.15?20:40;return m<.05?14:m<.15?22:40}
  const{key}=getBands(o);const b=bl.buckets[key];
  return(b?.p95||40)*CFG.blWarn}

// ── Analysis ────────────────────────────────────────────────────
function analyze(ptOpts, baseline, spots){
  return ptOpts.map(o=>{
    const hasBid=o.bid!=null&&o.bid>0,hasAsk=o.ask!=null&&o.ask>0;
    const th=dynSprdTh(o,baseline);
    let status='EMPTY';
    if(hasBid&&hasAsk)status=o.sprd!=null&&o.sprd>=th?'WIDE':'QUOTED';
    else if(hasBid||hasAsk)status='ONE_SIDED';
    let iv=null;
    if(o.mid>0&&o.spot>0&&o.T>1e-6)iv=solveIV(o.mid,o.spot,o.strike,o.T,0,o.cp);
    // Moneyness
    const S=spots[o.asset]||o.spot||0;
    const moneyness=S>0?Math.abs(o.strike-S)/S:1;
    // Baseline deviation
    let blDev=null;
    if(baseline){const bo=baseline.options[o.raw];
      if(bo){const wasQ=bo.status==='QUOTED'||bo.status==='WIDE';
        if(wasQ&&(status==='EMPTY'||status==='ONE_SIDED'))blDev='PULLED';
        else if(wasQ&&o.sprd!=null&&bo.sprd>0){
          const ratio=o.sprd/bo.sprd;
          if(ratio>CFG.blCrit)blDev='BLOWN';else if(ratio>CFG.blWarn)blDev='DRIFTED'}}}
    return{...o,status,iv,th,blDev,moneyness}})
}

// ═══════════════════════════════════════════════════════════════════
// SMART ALERT GENERATION — grouped + materiality-filtered
// ═══════════════════════════════════════════════════════════════════
function generateAlerts(items, ptPerps, mktOpts, mktPerps, baseline, spots){
  const urgent = [];  // 🔴 act now
  const watch = [];   // 🟡 be aware
  const stats = { totalOpts:items.length, suppressed:0 };

  // ── 1. QUOTER HEALTH (the most important signal) ──────────────
  if(baseline){
    let matching=0, blQuoted=0, coveredCount=0;
    for(const o of items){
      const bo=baseline.options[o.raw];
      if(!bo||bo.status==='EMPTY')continue;
      blQuoted++;
      if(o.status==='QUOTED'||o.status==='WIDE'){coveredCount++;
        const{key}=getBands(o);const b=baseline.buckets[key];
        const blSprd=b?.p95||bo.sprd||50;
        if(o.sprd!=null&&o.sprd<=blSprd*2)matching++}}
    const health=blQuoted>0?Math.round(matching/blQuoted*100):100;
    const coverage=blQuoted>0?Math.round(coveredCount/blQuoted*100):100;
    stats.health=health;stats.coverage=coverage;stats.blQuoted=blQuoted;
    if(health<CFG.healthCritical){
      urgent.push(`🚨 <b>QUOTER HEALTH ${health}%</b> — ${matching}/${blQuoted} matching baseline, coverage ${coverage}%. Quoter may be down or degraded.`)}
    else if(health<CFG.healthWarning){
      watch.push(`⚠️ Quoter health ${health}% (coverage ${coverage}%) — below normal`)}
  }

  // ── 2. QUOTE PULLS — grouped by asset ─────────────────────────
  const pulls=items.filter(o=>o.blDev==='PULLED');
  // Only care about material pulls: has OI, or is near-the-money
  const materialPulls=pulls.filter(o=>o.oi>=CFG.pullMinOI||o.moneyness<CFG.pullMoneyness);
  const immaterialPulls=pulls.length-materialPulls.length;
  stats.suppressed+=immaterialPulls;

  if(materialPulls.length>0){
    // Group by asset
    const byAsset={};
    for(const o of materialPulls){if(!byAsset[o.asset])byAsset[o.asset]=[];byAsset[o.asset].push(o)}
    for(const[asset,opts] of Object.entries(byAsset)){
      const withOI=opts.filter(o=>o.oi>0);
      const totalOI=opts.reduce((s,o)=>s+o.oi,0);
      const strikes=opts.map(o=>o.strike).sort((a,b)=>a-b);
      const S=spots[asset]||0;
      const sRange=S>0?`${(strikes[0]/S*100-100).toFixed(0)}% to ${(strikes[strikes.length-1]/S*100-100).toFixed(0)}% from spot`:`$${strikes[0]}—$${strikes[strikes.length-1]}`;
      const expiries=[...new Set(opts.map(o=>o.expiry))].sort();

      if(withOI.length>0){
        urgent.push(`📉 <b>${asset}: ${opts.length} quotes pulled</b> (${withOI.length} with OI, total OI: ${totalOI})\nStrikes: ${sRange} | Expiries: ${expiries.join(', ')}`);
      }else{
        watch.push(`📉 ${asset}: ${opts.length} quotes pulled (${sRange}, ${expiries.length} expiries, 0 OI)`);
      }
    }
  }

  // ── 3. SPREADS BLOWN — grouped by asset ───────────────────────
  const blown=items.filter(o=>o.blDev==='BLOWN'&&(o.oi>=CFG.blownMinOI||o.moneyness<0.1));
  if(blown.length>0){
    const byAsset={};
    for(const o of blown){if(!byAsset[o.asset])byAsset[o.asset]=[];byAsset[o.asset].push(o)}
    for(const[asset,opts] of Object.entries(byAsset)){
      const worst=opts.sort((a,b)=>(b.sprd||0)-(a.sprd||0))[0];
      const blSprd=baseline?.options[worst.raw]?.sprd||0;
      urgent.push(`📏 <b>${asset}: ${opts.length} spreads blown</b> — worst: ${worst.raw} at ${worst.sprd?.toFixed(0)}% (was ${blSprd.toFixed(0)}%)`);
    }
  }

  // ── 4. EXPIRING WITH OI — only <4h and OI>0 ──────────────────
  const expiring=items.filter(o=>{
    const hrs=o.T*365*24;
    return hrs>0&&hrs<=CFG.expiryAlertH&&o.oi>=CFG.expiryMinOI});
  if(expiring.length>0){
    const byAsset={};
    for(const o of expiring){if(!byAsset[o.asset])byAsset[o.asset]=[];byAsset[o.asset].push(o)}
    for(const[asset,opts] of Object.entries(byAsset)){
      const totalOI=opts.reduce((s,o)=>s+o.oi,0);
      const hrs=(opts[0].T*365*24).toFixed(1);
      urgent.push(`⏱ <b>${asset}: ${opts.length} options expiring in ${hrs}h</b> with ${totalOI} total OI — verify settlement hedges`);
    }
  }
  // Suppress OI=0 expiring (just count them)
  const expiringNoOI=items.filter(o=>o.T*365*24>0&&o.T*365*24<=CFG.expiryAlertH&&o.oi<CFG.expiryMinOI);
  stats.suppressed+=expiringNoOI.length;

  // ── 5. EXECUTABLE ARBS — only profitable ones ─────────────────
  const isLiquid=m=>m.bid>0&&m.ask>0&&m.vol24h>=CFG.minExtVol&&m.oi>=CFG.minExtOI;
  const mktByK={};
  for(const o of mktOpts){if(o.T<2/365||o.mid<=0)continue;const k=`${o.asset}-${o.strike}-${o.expiry}-${o.cp}`;if(!mktByK[k])mktByK[k]=[];mktByK[k].push(o)}
  const arbs=[];
  for(const pt of items){
    if(pt.mid<=0||pt.T<2/365||pt.mid<1)continue;
    const k=`${pt.asset}-${pt.strike}-${pt.expiry}-${pt.cp}`;const mkts=mktByK[k];if(!mkts)continue;
    const liq=mkts.filter(isLiquid);if(!liq.length)continue;
    const mktAvg=liq.reduce((s,m)=>s+m.mid,0)/liq.length;
    const pctDiff=((pt.mid-mktAvg)/mktAvg)*100;
    if(Math.abs(pctDiff)<CFG.ptVsMkt)continue;
    const cheap=pctDiff<0;
    if(cheap&&pt.ask>0){
      const best=liq.reduce((b,m)=>m.bid>(b?.bid||0)?m:b,null);
      if(best?.bid>0){
        const gross=best.bid*(1-SLIP)-pt.ask*(1+SLIP);
        const fees=pt.ask*FEES.PT.t+best.bid*(FEES[best.ex]?.t||.0005);
        const net=gross-fees;
        if(net>=CFG.minArbNet)arbs.push({asset:pt.asset,sym:pt.raw,dir:'BUY PT → SELL '+best.ex,ptPrice:pt.ask,mktPrice:best.bid,net,diff:pctDiff,ex:best.ex})}}
    else if(!cheap&&pt.bid>0){
      const best=liq.filter(m=>m.ask>0).reduce((b,m)=>!b||m.ask<b.ask?m:b,null);
      if(best?.ask>0){
        const gross=pt.bid*(1-SLIP)-best.ask*(1+SLIP);
        const fees=pt.bid*FEES.PT.t+best.ask*(FEES[best.ex]?.t||.0005);
        const net=gross-fees;
        if(net>=CFG.minArbNet)arbs.push({asset:pt.asset,sym:pt.raw,dir:'SELL PT → BUY '+best.ex,ptPrice:pt.bid,mktPrice:best.ask,net,diff:pctDiff,ex:best.ex})}}}
  if(arbs.length>0){
    arbs.sort((a,b)=>b.net-a.net);
    for(const a of arbs.slice(0,5)){
      urgent.push(`💰 <b>${a.asset} ARB $${a.net.toFixed(0)}</b>: ${a.dir}\n<code>${a.sym}</code> PT $${a.ptPrice.toFixed(2)} vs ${a.ex} $${a.mktPrice.toFixed(2)} (${a.diff.toFixed(1)}%)`)}
    if(arbs.length>5)watch.push(`💰 ${arbs.length-5} more arb opportunities (top 5 shown)`)}

  // ── 6. PERP BASIS + FUNDING ARBS ──────────────────────────────
  const pBA={};
  for(const p of[...ptPerps,...mktPerps]){if(!p.isPerpetual)continue;if(!pBA[p.asset])pBA[p.asset]={};pBA[p.asset][p.ex]=p}
  for(const[asset,em] of Object.entries(pBA)){
    const pt=em.PT;if(!pt)continue;
    for(const[ex,mp] of Object.entries(em)){if(ex==='PT')continue;
      const bdBps=Math.abs(pt.basis-mp.basis)*100;
      if(bdBps>=CFG.perpBps){
        const net=Math.abs(pt.mark-mp.mark)-(pt.mark+mp.mark)/2*(FEES.PT.t+(FEES[ex]?.t||.0005));
        if(net>0)watch.push(`⚡ ${asset} perp basis: PT ${pt.basis.toFixed(3)}% vs ${ex} ${mp.basis.toFixed(3)}% (Δ${bdBps.toFixed(1)}bps, ~$${net.toFixed(0)})`)}
      if(pt.funding!=null&&mp.funding!=null){
        const fdBps=Math.abs(pt.funding-mp.funding)*10000;
        if(fdBps>=CFG.fundBps)watch.push(`💸 ${asset} funding: PT ${(pt.funding*10000).toFixed(1)}bps vs ${ex} ${(mp.funding*10000).toFixed(1)}bps (Δ${fdBps.toFixed(1)}bps)`)}
    }}

  // ── 7. IV DISLOCATIONS — only large ones ──────────────────────
  for(const pt of items){
    if(!pt.iv||pt.mid<1||pt.T<2/365)continue;
    const k=`${pt.asset}-${pt.strike}-${pt.expiry}-${pt.cp}`;const mkts=mktByK[k];if(!mkts)continue;
    const liq=mkts.filter(isLiquid);
    for(const m of liq){
      const mIv=m.markIv;if(!mIv)continue;
      const d=(pt.iv-mIv)*100;
      if(Math.abs(d)>=CFG.ivArb*2){ // only alert on 2x threshold = significant
        watch.push(`📊 ${pt.asset} IV: PT ${(pt.iv*100).toFixed(0)}% vs ${m.ex} ${(mIv*100).toFixed(0)}% (Δ${d.toFixed(0)}pts) — <code>${pt.raw}</code>`);
        break; // one alert per option
      }}}

  return{urgent,watch,stats}}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE FORMATTING — concise, one-screen, actionable
// ═══════════════════════════════════════════════════════════════════
function formatTelegram(urgent, watch, stats, spots, baseline){
  const now=new Date();
  const time=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'});

  // Header — just BTC/ETH/SOL + health
  const mainSpots=['BTC','ETH','SOL'].filter(a=>spots[a]).map(a=>`${a} $${Math.round(spots[a]).toLocaleString()}`).join(' · ');
  const blAge=baseline?((Date.now()-baseline.timestamp)/3600000).toFixed(1)+'h':'none';
  const healthStr=stats.health!=null?`${stats.health}%`:'N/A';

  let msg=`<b>🚨 PT Police</b> — ${time} UTC\n`;
  msg+=`${mainSpots}\n`;
  msg+=`Health: <b>${healthStr}</b> | BL: ${blAge} | ${stats.totalOpts} opts\n`;

  if(urgent.length===0&&watch.length===0){
    msg+=`\n✅ <b>All clear.</b> No actionable issues.`;
    if(stats.suppressed>0)msg+=`\n<i>(${stats.suppressed} low-priority items suppressed)</i>`;
    return{msg,hasUrgent:false}}

  // Urgent section
  if(urgent.length>0){
    msg+=`\n🔴 <b>ACTION REQUIRED (${urgent.length})</b>\n`;
    msg+=urgent.join('\n\n')+'\n';
  }

  // Watch section — keep it brief
  if(watch.length>0){
    msg+=`\n🟡 <b>WATCH (${watch.length})</b>\n`;
    msg+=watch.slice(0,8).join('\n')+'\n';
    if(watch.length>8)msg+=`<i>...+${watch.length-8} more</i>\n`;
  }

  if(stats.suppressed>0)msg+=`\n<i>${stats.suppressed} non-material items suppressed</i>`;

  return{msg,hasUrgent:urgent.length>0}}

function formatSlack(urgent, watch, stats, spots, baseline){
  const mainSpots=['BTC','ETH','SOL'].filter(a=>spots[a]).map(a=>`${a} $${Math.round(spots[a]).toLocaleString()}`).join(' · ');
  const healthStr=stats.health!=null?`${stats.health}%`:'N/A';
  const blAge=baseline?((Date.now()-baseline.timestamp)/3600000).toFixed(1)+'h':'none';

  const blocks=[{type:'header',text:{type:'plain_text',text:`🚨 PT Police — ${urgent.length} urgent, ${watch.length} watch`}}];
  blocks.push({type:'section',text:{type:'mrkdwn',text:`${mainSpots} | Health: *${healthStr}* | BL: ${blAge}`}});

  if(urgent.length===0&&watch.length===0){
    blocks.push({type:'section',text:{type:'mrkdwn',text:'✅ *All clear.* No actionable issues.'}});
    return blocks}

  if(urgent.length>0){
    blocks.push({type:'divider'});
    // Convert HTML to Slack mrkdwn (rough)
    const slackUrgent=urgent.map(u=>u.replace(/<b>/g,'*').replace(/<\/b>/g,'*').replace(/<code>/g,'`').replace(/<\/code>/g,'`').replace(/<\/?[^>]+>/g,'')).join('\n\n');
    blocks.push({type:'section',text:{type:'mrkdwn',text:`🔴 *ACTION REQUIRED*\n${slackUrgent}`}});}

  if(watch.length>0){
    const slackWatch=watch.slice(0,5).map(w=>w.replace(/<b>/g,'*').replace(/<\/b>/g,'*').replace(/<code>/g,'`').replace(/<\/code>/g,'`').replace(/<\/?[^>]+>/g,'')).join('\n');
    blocks.push({type:'section',text:{type:'mrkdwn',text:`🟡 *WATCH*\n${slackWatch}${watch.length>5?`\n_+${watch.length-5} more_`:''}`}});}

  return blocks}

// ── Dispatchers ─────────────────────────────────────────────────
async function sendTelegram(msg){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return;
  // Telegram limit is 4096 chars
  const truncated=msg.length>4000?msg.slice(0,3950)+'\n\n<i>...truncated</i>':msg;
  const url=`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:truncated,parse_mode:'HTML',disable_web_page_preview:true})});
  const rj=await r.json();
  console.log(`Telegram: ${rj.ok?'sent':'ERROR: '+rj.description}`)}

async function sendSlack(blocks){
  if(!SLACK_WEBHOOK)return;
  const r=await fetch(SLACK_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({blocks})});
  console.log(`Slack: ${r.status}`)}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main(){
  console.log(`\n═══ PT Police v5.1 — ${new Date().toISOString()} ═══\n`);

  // Load baseline
  let baseline=null;
  if(fs.existsSync(BASELINE_PATH)){
    try{baseline=JSON.parse(fs.readFileSync(BASELINE_PATH,'utf8'));
      const ageH=(Date.now()-baseline.timestamp)/3600000;
      console.log(`Baseline: ${baseline.quotedCount} opts, ${ageH.toFixed(1)}h old`);
      if(ageH>CFG.blMaxAgeH){console.log('Baseline expired — will recapture');baseline=null}}
    catch(e){console.log('Bad baseline:',e.message)}}

  // Fetch
  console.log('Fetching all exchanges...');
  const[ptR,...mktRs]=await Promise.allSettled([fetchPT(),fetchDeribit('BTC'),fetchDeribit('ETH'),fetchDeribit('SOL'),fetchOKX('BTC'),fetchOKX('ETH'),fetchBybit('BTC'),fetchBybit('ETH'),fetchBybit('SOL'),fetchCoinCall('BTC'),fetchCoinCall('ETH'),fetchCoinCall('SOL')]);

  if(ptR.status!=='fulfilled'||!ptR.value?.ok){console.error('PT failed — aborting');process.exit(1)}
  const pt=ptR.value;
  console.log(`PT: ${pt.opts.length} opts, ${pt.perps.length} perps`);

  let mktOpts=[],mktPerps=[];
  const exN=['Deribit','Deribit','Deribit','OKX','OKX','Bybit','Bybit','Bybit','CoinCall','CoinCall','CoinCall'];
  mktRs.forEach((r,i)=>{if(r.status==='fulfilled'&&r.value){
    if(r.value.oOk)mktOpts=mktOpts.concat(r.value.opts);
    if(r.value.fOk)mktPerps=mktPerps.concat(r.value.perps)}
    else console.log(`${exN[i]} failed`)});
  console.log(`Market: ${mktOpts.length} opts, ${mktPerps.length} perps`);

  // Analyze
  const items=analyze(pt.opts, baseline, pt.spots);

  // Baseline capture/refresh
  if(!baseline){
    console.log('Capturing baseline...');
    baseline=buildBaseline(items);
    fs.writeFileSync(BASELINE_PATH,JSON.stringify(baseline));
    console.log(`Saved: ${baseline.quotedCount}/${baseline.totalCount} quoted`)}

  // Generate alerts
  const{urgent,watch,stats}=generateAlerts(items,pt.perps,mktOpts,mktPerps,baseline,pt.spots);
  console.log(`\nResults: ${urgent.length} urgent, ${watch.length} watch, ${stats.suppressed} suppressed`);

  // Format messages
  const{msg:telegramMsg,hasUrgent}=formatTelegram(urgent,watch,stats,pt.spots,baseline);
  const slackBlocks=formatSlack(urgent,watch,stats,pt.spots,baseline);

  // Only send if there's something worth saying
  // "All clear" messages sent once per hour (check via env or just always send — it's short)
  const shouldSend=hasUrgent||watch.length>0;

  if(DRY_RUN){
    console.log('\n--- DRY RUN ---');
    console.log(telegramMsg.replace(/<[^>]+>/g,''));
    return}

  if(!shouldSend){
    console.log('All clear — skipping notification');
    return}

  await Promise.allSettled([sendTelegram(telegramMsg),sendSlack(slackBlocks)]);
  console.log('Done.')}

main().catch(e=>{console.error('Fatal:',e);process.exit(1)});
