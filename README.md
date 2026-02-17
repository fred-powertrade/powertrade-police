# 🚨 PowerTrade Police v3

Live orderbook health monitor for PowerTrade, with cross-exchange comparison against Deribit, OKX, and Bybit.

## Deploy (free, 2 minutes)

GitHub Pages is **free for public repos** — no premium needed.

1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Under "Source", select **Deploy from a branch**
4. Choose **main** branch, **/ (root)** folder → **Save**
5. Wait ~60 seconds, your dashboard is live at:
   ```
   https://YOUR-USERNAME.github.io/powertrade-police/
   ```

## What it does

| Tab | Description |
|-----|-------------|
| 🏥 **Orderbook Health** | Every PT option classified: ✅ Quoted, ⚡ Wide spread, ⚠ One-sided, ❌ Empty. Health score per expiry. Volume comparison vs peer strikes. |
| 🚨 **Alerts** | Wide spreads, one-sided books, PT vs market mispricing, perp basis arbs. Filterable by asset, severity, category. |
| ⚖️ **PT vs Market** | Strike-by-strike comparison of PT bid/ask against Deribit/OKX/Bybit. Shows which strikes are cheap or rich vs market. |
| 📊 **Perps** | Cross-exchange perpetual comparison: mark, bid, ask, spread, basis, funding. |
| 🎚 **Config** | Adjustable thresholds, presets for liquid/illiquid markets, CORS proxy toggle. |

## APIs used (all public, no auth)

| Exchange | Endpoint |
|----------|----------|
| **PowerTrade** ★ | `api.rest.prod.power.trade/v1/market_data/tradeable_entity/all/summary` |
| Deribit | `www.deribit.com/api/v2/public/get_book_summary_by_currency` |
| OKX | `www.okx.com/api/v5/market/tickers` |
| Bybit | `api.bybit.com/v5/market/tickers` |

## CORS

Browser security blocks cross-origin API calls from `github.io`. The dashboard handles this automatically:

- Tries direct fetch first
- If blocked → retries via `corsproxy.io` (free, no signup)
- Connection bar shows 🟢 direct or 🟣 proxied
- Toggle in Config tab

## Files

```
index.html   ← page structure
style.css    ← all styling
app.js       ← all logic (fetch, analysis, rendering)
```

Zero dependencies. No build step. No npm. Just static files.
