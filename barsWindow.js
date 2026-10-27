// barsWindow.js — Alpaca's /stocks/bars endpoint has two traps that silently returned
// bad/empty data across the whole scanner:
//   1. Given ONLY a `limit`, it returns 0 bars — it needs an explicit start/end window.
//   2. It returns bars OLDEST-first and truncates to `limit`, so a small limit yields
//      ancient bars, not recent ones.
// This builds a start/end window sized to hold ~`count` bars of the given timeframe,
// ending ~now (20-min back to respect the free IEX feed's 15-min delay). Callers should
// pass a HIGH api limit (e.g. 10000) so nothing is truncated, and use the tail.
'use strict';

module.exports = function barsWindow(count, timeframe = '1Day') {
    const end = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const perTradingDay = timeframe === '1Min' ? 390
                        : timeframe === '5Min' ? 78
                        : timeframe === '15Min' ? 26
                        : timeframe === '1Hour' ? 7
                        : 1;                                  // 1Day
    const tradingDays = Math.ceil(count / perTradingDay);
    const calDays = Math.ceil(tradingDays * 1.5) + 5;         // calendar days ⊃ trading days (weekends/holidays)
    const start = new Date(Date.now() - calDays * 86400000).toISOString();
    return { start, end };
};
