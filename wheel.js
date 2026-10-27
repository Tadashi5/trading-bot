// wheel.js — Wheel Strategy: Cash-Secured Puts → Covered Calls
require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const smartFilters = require('./smartFilters');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE      = process.env.ALPACA_BASE_URL;
const DATA_BASE = 'https://data.alpaca.markets/v2';

// ── Universe ──────────────────────────────────────────────────────────────────
// AUS/JPN/CHN are represented by US-listed ADRs and market ETFs that have
// liquid options on US exchanges. findContract gracefully skips any ticker
// without available contracts.
const WHEEL_STOCKS = {
    // Cheap, highly-liquid optionable names — a cash-secured put on these needs only
    // a few hundred dollars, so the wheel can actually operate at a small account
    // size. The mega-caps below need $20k-40k per contract and stay dormant until
    // the account is much larger. (Account is ~$1k, so realistically only these run.)
    value: ['NIO', 'SOFI', 'F',  'PLUG', 'VALE', 'RIG',  'XPEV', 'PLTR'],
    usa: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'AVGO', 'V'   ],
    aus: ['BHP',  'RIO',  'EWA',  'GOLD', 'WPM',   'FCX',  'SCCO', 'ALB', 'MP'          ],
    jpn: ['TM',   'SONY', 'HMC',  'MUFG', 'EWJ',   'SMFG', 'IX',   'MFG', 'NMR',  'NTDOY'],
    chn: ['BABA', 'JD',   'BIDU', 'PDD',  'LI',    'KWEB', 'FXI',  'MCHI'],
};
const ALL_TICKERS = [...new Set(Object.values(WHEEL_STOCKS).flat())];

const DATA_DIR   = require('./dataDir');
const STATE_FILE = path.join(DATA_DIR, 'wheel-state.json');

// ── State helpers ─────────────────────────────────────────────────────────────

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return { tickers: {}, totalPremium: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function getTS(state, ticker) {
    if (!state.tickers[ticker]) {
        state.tickers[ticker] = {
            stage: 1, costBasis: null, sharesOwned: 0,
            activeContract: null, cyclesPremium: 0, cycles: 0, log: [],
        };
    }
    return state.tickers[ticker];
}

function addLog(t, msg) {
    t.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (t.log.length > 30) t.log.shift();
    console.log(`[Wheel] ${msg}`);
}

// ── Alpaca helpers ────────────────────────────────────────────────────────────

async function getStockPrices(symbols) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/snapshots`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), feed: 'iex' },
        });
        const out = {};
        for (const [sym, snap] of Object.entries(res.data || {}))
            out[sym] = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        return out;
    } catch { return {}; }
}

function expiryRange() {
    const min = new Date(); min.setDate(min.getDate() + 14);
    const max = new Date(); max.setDate(max.getDate() + 28);
    return { gte: min.toISOString().split('T')[0], lte: max.toISOString().split('T')[0] };
}

async function findContract(symbol, type, targetStrike) {
    try {
        const { gte, lte } = expiryRange();
        const res = await axios.get(`${BASE}/options/contracts`, {
            headers: HEADERS,
            params: {
                underlying_symbols: symbol, type,
                expiration_date_gte: gte, expiration_date_lte: lte,
                status: 'active', limit: 50,
            },
        });
        const contracts = res.data.option_contracts || [];
        if (!contracts.length) return null;
        return contracts.reduce((best, c) =>
            Math.abs(parseFloat(c.strike_price) - targetStrike) <
            Math.abs(parseFloat(best.strike_price) - targetStrike) ? c : best
        );
    } catch { return null; }
}

async function placeOptionOrder(symbol, side, qty = 1) {
    try {
        const res = await axios.post(`${BASE}/orders`, {
            symbol, qty, side, type: 'market', time_in_force: 'day', order_class: 'simple',
        }, { headers: HEADERS });
        return { success: true, orderId: res.data.id };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ── Stage 1: Cash-Secured Put ─────────────────────────────────────────────────

async function sellCSP(ticker, t, state, price, cash) {
    const targetStrike = parseFloat((price * 0.90).toFixed(2));
    const cashNeeded   = targetStrike * 100; // 1 contract = 100 shares

    if (cash < cashNeeded) {
        addLog(t, `Skip CSP ${ticker}: need $${cashNeeded.toFixed(0)}, have $${cash.toFixed(0)}`);
        return;
    }

    const contract = await findContract(ticker, 'put', targetStrike);
    if (!contract) { addLog(t, `No put contracts for ${ticker} near $${targetStrike}`); return; }

    const result = await placeOptionOrder(contract.symbol, 'sell', 1);
    if (result.success) {
        t.activeContract = {
            symbol: contract.symbol, type: 'put',
            strike: parseFloat(contract.strike_price),
            expiry: contract.expiration_date,
            openedAt: new Date().toISOString(),
            premiumCaptured: false,
        };
        addLog(t, `SELL PUT ${contract.symbol} | strike $${contract.strike_price} | exp ${contract.expiration_date}`);
    } else {
        addLog(t, `SELL PUT ${ticker} failed: ${result.error}`);
    }
}

// ── Stage 2: Covered Call ─────────────────────────────────────────────────────

async function sellCoveredCall(ticker, t, state, price) {
    if (!t.costBasis) return;

    // Target ~10% above cost basis; always stay above cost basis
    const targetStrike = parseFloat(Math.max(t.costBasis * 1.10, price * 1.05).toFixed(2));

    const contract = await findContract(ticker, 'call', targetStrike);
    if (!contract) { addLog(t, `No call contracts for ${ticker} near $${targetStrike}`); return; }

    // Hard rule: never sell a call below what we paid for the shares
    if (parseFloat(contract.strike_price) < t.costBasis) {
        addLog(t, `Skip CALL ${ticker}: best strike $${contract.strike_price} < basis $${t.costBasis.toFixed(2)}`);
        return;
    }

    const result = await placeOptionOrder(contract.symbol, 'sell', 1);
    if (result.success) {
        t.activeContract = {
            symbol: contract.symbol, type: 'call',
            strike: parseFloat(contract.strike_price),
            expiry: contract.expiration_date,
            openedAt: new Date().toISOString(),
            premiumCaptured: false,
        };
        addLog(t, `SELL CALL ${contract.symbol} | strike $${contract.strike_price} | exp ${contract.expiration_date} | basis $${t.costBasis.toFixed(2)}`);
    } else {
        addLog(t, `SELL CALL ${ticker} failed: ${result.error}`);
    }
}

// ── Position management ───────────────────────────────────────────────────────

async function managePosition(ticker, t, state, equityPos, optionPositions) {
    const liveOptPos = t.activeContract
        ? optionPositions.find(p => p.symbol === t.activeContract.symbol)
        : null;

    // Capture actual premium on first appearance in positions (after fill)
    if (liveOptPos && t.activeContract && !t.activeContract.premiumCaptured) {
        const prem = parseFloat(liveOptPos.avg_entry_price) * 100;
        t.activeContract.premiumPerShare  = parseFloat(liveOptPos.avg_entry_price);
        t.activeContract.premiumTotal     = prem;
        t.activeContract.premiumCaptured  = true;
        t.cyclesPremium   += prem;
        state.totalPremium += prem;
        addLog(t, `Premium captured ${ticker}: $${prem.toFixed(2)}`);
    }

    // 50% profit target → close early and roll
    if (liveOptPos && t.activeContract?.premiumCaptured) {
        const entry   = parseFloat(liveOptPos.avg_entry_price);
        const current = parseFloat(liveOptPos.current_price);
        if (entry > 0 && (entry - current) / entry >= 0.50) {
            addLog(t, `${ticker} ${t.activeContract.type.toUpperCase()} at 50% profit — closing early ($${entry.toFixed(2)} → $${current.toFixed(2)})`);
            const close = await placeOptionOrder(t.activeContract.symbol, 'buy', 1);
            if (close.success) {
                t.activeContract = null;
                addLog(t, `${ticker} closed early. New contract next scan.`);
            }
        }
        return; // contract still open or just closed
    }

    // Contract gone — determine what happened (expiry / assignment / call-away)
    if (t.activeContract && !liveOptPos) {
        if (t.activeContract.type === 'put') {
            if (equityPos) {
                // Assigned — move to Stage 2
                const avgEntry = parseFloat(equityPos.avg_entry_price);
                t.costBasis    = avgEntry - (t.cyclesPremium / 100); // effective basis net of premiums
                t.sharesOwned  = Math.abs(parseInt(equityPos.qty));
                t.stage        = 2;
                t.activeContract = null;
                addLog(t, `ASSIGNED ${ticker} — ${t.sharesOwned} shares @ $${avgEntry.toFixed(2)} | effective basis: $${t.costBasis.toFixed(2)}`);
            } else {
                // Expired worthless — premium is ours, repeat Stage 1
                addLog(t, `PUT expired worthless ${ticker} — premium kept, selling new put`);
                t.activeContract = null;
            }
        } else if (t.activeContract.type === 'call') {
            if (!equityPos) {
                // Shares called away — full cycle complete, back to Stage 1
                t.cycles      += 1;
                t.cyclesPremium = 0;
                t.costBasis   = null;
                t.sharesOwned = 0;
                t.stage       = 1;
                t.activeContract = null;
                addLog(t, `CALLED AWAY ${ticker} — cycle ${t.cycles} complete. Back to Stage 1.`);
            } else {
                // Call expired worthless — still own shares, sell another call
                addLog(t, `CALL expired worthless ${ticker} — still holding, selling new call`);
                t.activeContract = null;
            }
        }
    }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan() {
    const state = loadState();
    const [accountRes, posRes] = await Promise.all([
        axios.get(`${BASE}/account`,   { headers: HEADERS }),
        axios.get(`${BASE}/positions`, { headers: HEADERS }),
    ]);
    const cash            = parseFloat(accountRes.data.cash);
    const all             = posRes.data;
    const equityPositions = all.filter(p => p.asset_class === 'us_equity');
    const optionPositions = all.filter(p => p.asset_class === 'us_option');

    const [prices, ivRankData] = await Promise.all([
        getStockPrices(ALL_TICKERS),
        smartFilters.getIVRank(ALL_TICKERS),
    ]);
    const results = [];

    for (const ticker of ALL_TICKERS) {
        const t         = getTS(state, ticker);
        const equityPos = equityPositions.find(p => p.symbol === ticker);

        // Sync share count from live positions (Alpaca is source of truth)
        if (equityPos) {
            t.sharesOwned = Math.abs(parseInt(equityPos.qty));
            if (t.costBasis === null) {
                t.costBasis = parseFloat(equityPos.avg_entry_price);
                t.stage = 2;
            }
        } else if (t.stage === 1) {
            t.sharesOwned = 0;
        }

        await managePosition(ticker, t, state, equityPos, optionPositions);

        // Open new position when no active contract (IV rank filter)
        if (!t.activeContract && prices[ticker]) {
            const ivCheck = smartFilters.wheelIVFilter(ivRankData[ticker]);
            if (t.stage === 1 && ivCheck.ok) {
                await sellCSP(ticker, t, state, prices[ticker], cash);
            } else if (t.stage === 2 && t.sharesOwned >= 100 && ivCheck.ok) {
                await sellCoveredCall(ticker, t, state, prices[ticker]);
            } else if (!ivCheck.ok) {
                // IV too low — skip and log
                t.ivSkipReason = ivCheck.reason;
            }
        }

        state.tickers[ticker] = t;
        results.push({
            ticker,
            market:        Object.entries(WHEEL_STOCKS).find(([, v]) => v.includes(ticker))?.[0] || '—',
            stage:         t.stage,
            price:         prices[ticker] || null,
            contract:      t.activeContract,
            costBasis:     t.costBasis,
            sharesOwned:   t.sharesOwned,
            cyclesPremium: t.cyclesPremium,
            totalCycles:   t.cycles,
            recentLog:     t.log.slice(-3),
        });
    }

    saveState(state);
    return { results, totalPremium: state.totalPremium, cash };
}

// ── Daily summary ─────────────────────────────────────────────────────────────

function dailySummary() {
    const state  = loadState();
    const active = Object.entries(state.tickers)
        .filter(([, t]) => t.stage === 2 || t.activeContract || t.cycles > 0);

    const lines = [
        `════ WHEEL — MARKET CLOSE ${new Date().toLocaleDateString()} ════`,
        `All-time premium: $${state.totalPremium.toFixed(2)} | Active positions: ${active.length}`,
        '',
    ];

    for (const [ticker, t] of active) {
        const mkt = (Object.entries(WHEEL_STOCKS).find(([, v]) => v.includes(ticker))?.[0] || '').toUpperCase();
        lines.push(`${ticker} [${mkt}] Stage ${t.stage} | Cycles: ${t.cycles} | Cycle premium: $${t.cyclesPremium.toFixed(2)}`);
        if (t.activeContract) {
            const c = t.activeContract;
            lines.push(`  → ${c.type.toUpperCase()} ${c.symbol} | Strike $${c.strike} | Exp ${c.expiry} | Premium $${(c.premiumTotal || 0).toFixed(2)}`);
        }
        if (t.costBasis) lines.push(`  → Basis $${t.costBasis.toFixed(2)} | Shares: ${t.sharesOwned}`);
    }
    lines.push('═══════════════════════════════════════════════════════');
    return lines.join('\n');
}

// ── Active wheel tickers (for external modules to avoid conflicts) ────────────
// Returns a Set of tickers the wheel currently has an active contract OR
// owns shares on (stage 2). options.js uses this to avoid trading the same
// underlying in the opposite direction at the same time.
function getActiveTickers() {
    const state = loadState();
    const active = new Set();
    for (const [ticker, t] of Object.entries(state.tickers || {})) {
        if (t.activeContract || t.stage === 2 || t.sharesOwned > 0) {
            active.add(ticker);
        }
    }
    return active;
}

module.exports = { scan, dailySummary, getActiveTickers, WHEEL_STOCKS, ALL_TICKERS };
