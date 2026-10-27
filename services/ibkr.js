// ibkr.js — Interactive Brokers Client Portal API integration
// Covers: ASX, Nikkei, HSI, LSE, and any global exchange
// Requires IBKR Client Portal Gateway running (or IBKR Web API)
// Docs: https://ibkrcampus.com/ibkr-api-page/cpapi-v1/
const axios = require('axios');

const GATEWAY_URL = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api';
const ACCOUNT_ID = process.env.IBKR_ACCOUNT_ID || '';

// IBKR uses conids (contract IDs) — we map common symbols
const EXCHANGE_MAP = {
    // ASX
    'BHP.AX':  { conid: null, exchange: 'ASX', currency: 'AUD' },
    'CBA.AX':  { conid: null, exchange: 'ASX', currency: 'AUD' },
    'CSL.AX':  { conid: null, exchange: 'ASX', currency: 'AUD' },
    // Nikkei
    '7203.T':  { conid: null, exchange: 'TSE', currency: 'JPY' },
    '6758.T':  { conid: null, exchange: 'TSE', currency: 'JPY' },
    '9984.T':  { conid: null, exchange: 'TSE', currency: 'JPY' },
    // HSI
    '0700.HK': { conid: null, exchange: 'SEHK', currency: 'HKD' },
    '9988.HK': { conid: null, exchange: 'SEHK', currency: 'HKD' },
    // LSE
    'SHEL.L':  { conid: null, exchange: 'LSE', currency: 'GBP' },
    'AZN.L':   { conid: null, exchange: 'LSE', currency: 'GBP' },
};

// Axios instance with self-signed cert handling (IBKR gateway uses self-signed SSL)
const api = axios.create({
    baseURL: GATEWAY_URL,
    timeout: 15000,
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    headers: { 'Content-Type': 'application/json' },
});

// ── Auth ─────────────────────────────────────────────────────────────────────
async function checkAuth() {
    try {
        const res = await api.get('/iserver/auth/status');
        return { authenticated: res.data.authenticated, competing: res.data.competing, message: res.data.message };
    } catch (err) {
        return { authenticated: false, error: err.message };
    }
}

async function keepAlive() {
    try {
        await api.post('/tickle');
        return true;
    } catch { return false; }
}

// ── Search for contract ID by symbol ─────────────────────────────────────────
async function searchContract(symbol, exchange) {
    try {
        const res = await api.get('/iserver/secdef/search', {
            params: { symbol: symbol.replace(/\.\w+$/, ''), name: true },
        });
        if (!res.data?.length) return null;
        // Find matching exchange
        const match = res.data.find(c =>
            c.description?.includes(exchange) || c.conid
        ) || res.data[0];
        return match;
    } catch { return null; }
}

// ── Resolve conid for a symbol ───────────────────────────────────────────────
async function resolveConid(symbol) {
    const mapped = EXCHANGE_MAP[symbol];
    if (mapped?.conid) return mapped.conid;

    // Search IBKR for the contract
    const exchange = mapped?.exchange || '';
    const contract = await searchContract(symbol, exchange);
    if (contract?.conid) {
        if (mapped) mapped.conid = contract.conid; // cache it
        return contract.conid;
    }
    return null;
}

// ── Market Data ──────────────────────────────────────────────────────────────
async function getSnapshot(conids) {
    if (!conids.length) return {};
    try {
        const fields = '31,84,85,86,87,88'; // last,bid,ask,change,change%,volume
        const res = await api.get(`/iserver/marketdata/snapshot`, {
            params: { conids: conids.join(','), fields },
        });
        const map = {};
        for (const snap of (res.data || [])) {
            map[snap.conid] = {
                price: parseFloat(snap['31']) || 0,
                bid: parseFloat(snap['84']) || 0,
                ask: parseFloat(snap['85']) || 0,
                change: parseFloat(snap['86']) || 0,
                changePct: parseFloat(snap['87']) || 0,
                volume: parseInt(snap['88']) || 0,
            };
        }
        return map;
    } catch { return {}; }
}

async function getHistory(conid, period = '1d', bar = '1h') {
    try {
        const res = await api.get(`/iserver/marketdata/history`, {
            params: { conid, period, bar },
        });
        return res.data?.data || [];
    } catch { return []; }
}

// ── Orders ───────────────────────────────────────────────────────────────────
async function placeOrder(conid, side, qty, orderType = 'MKT', price = null) {
    if (!ACCOUNT_ID) return { success: false, error: 'IBKR_ACCOUNT_ID not set' };
    try {
        const order = {
            acctId: ACCOUNT_ID,
            conid: parseInt(conid),
            secType: 'STK',
            orderType,
            side: side.toUpperCase(),
            quantity: qty,
            tif: 'DAY',
        };
        if (orderType === 'LMT' && price) order.price = price;

        const res = await api.post(`/iserver/account/${ACCOUNT_ID}/orders`, { orders: [order] });

        // IBKR may return order confirmation questions
        if (res.data?.[0]?.id) {
            // Auto-confirm (reply to confirmation)
            try {
                await api.post(`/iserver/reply/${res.data[0].id}`, { confirmed: true });
            } catch {}
        }

        return { success: true, data: res.data };
    } catch (err) {
        return { success: false, error: err.response?.data?.error || err.message };
    }
}

async function cancelOrder(orderId) {
    if (!ACCOUNT_ID) return { success: false, error: 'IBKR_ACCOUNT_ID not set' };
    try {
        await api.delete(`/iserver/account/${ACCOUNT_ID}/order/${orderId}`);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ── Account ──────────────────────────────────────────────────────────────────
async function getAccounts() {
    try {
        const res = await api.get('/iserver/accounts');
        return res.data?.accounts || [];
    } catch { return []; }
}

async function getPositions() {
    if (!ACCOUNT_ID) return [];
    try {
        const res = await api.get(`/portfolio/${ACCOUNT_ID}/positions/0`);
        return (res.data || []).map(p => ({
            symbol: p.contractDesc || p.ticker,
            conid: p.conid,
            qty: p.position,
            avgCost: p.avgCost,
            marketValue: p.mktValue,
            unrealizedPnl: p.unrealizedPnl,
            realizedPnl: p.realizedPnl,
            currency: p.currency,
            exchange: p.listingExchange,
        }));
    } catch { return []; }
}

async function getOrders() {
    try {
        const res = await api.get('/iserver/account/orders');
        return (res.data?.orders || []).map(o => ({
            orderId: o.orderId,
            symbol: o.ticker,
            side: o.side,
            qty: o.remainingQuantity || o.totalQuantity,
            orderType: o.orderType,
            status: o.status,
            filledQty: o.filledQuantity,
            price: o.price,
            avgPrice: o.avgPrice,
        }));
    } catch { return []; }
}

async function getAccountSummary() {
    if (!ACCOUNT_ID) return null;
    try {
        const res = await api.get(`/portfolio/${ACCOUNT_ID}/summary`);
        return {
            netLiquidation: res.data?.netliquidation?.amount,
            totalCash: res.data?.totalcashvalue?.amount,
            unrealizedPnl: res.data?.unrealizedpnl?.amount,
            realizedPnl: res.data?.realizedpnl?.amount,
            buyingPower: res.data?.buyingpower?.amount,
            currency: res.data?.netliquidation?.currency,
        };
    } catch { return null; }
}

// ── Status ───────────────────────────────────────────────────────────────────
function isConfigured() {
    return !!(process.env.IBKR_GATEWAY_URL && process.env.IBKR_ACCOUNT_ID);
}

module.exports = {
    checkAuth, keepAlive, searchContract, resolveConid,
    getSnapshot, getHistory, placeOrder, cancelOrder,
    getAccounts, getPositions, getOrders, getAccountSummary,
    isConfigured, EXCHANGE_MAP,
};
