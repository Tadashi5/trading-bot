// main.js — ML Trading Pipeline Runtime Engine
// DATA → FEATURES → REGIME → ML MODEL → SIGNAL → RISK → EXECUTION → LOGGING → RL
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { stream }       = require('./stream');
const features         = require('./core/features');
const regime           = require('./core/regime');
const signal           = require('./core/signal');
const risk             = require('./core/risk');
const execution        = require('./core/execution');
const model            = require('./ml/model');
const rlAgent          = require('./ml/rlAgent');
const sentiment        = require('./services/sentiment');
const tradeJournal     = require('../tradeJournal');
const postExitTracker  = require('../postExitTracker');

// Trade log (in-memory + file-backed via journal)
const tradeLog = [];
let capital = 0;
let initialCapital = 0;
let halted = false;

// Track open ML positions for PnL calc
const openPositions = {};

async function run() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ML TRADING PIPELINE — STARTING');
    console.log('  Mode:', execution.MODE);
    console.log('═══════════════════════════════════════════════════');

    // Get initial capital
    const account = await execution.getAccount();
    capital = account.equity || parseFloat(process.env.PAPER_CAPITAL || '1000');
    initialCapital = capital;
    risk.reset(capital);
    console.log(`[ML] Capital: $${capital.toFixed(2)}`);

    // Main loop: poll every 60s
    const tickStream = stream(60000);

    for await (const ticks of tickStream) {
        if (halted) {
            console.log('[ML] HALTED — kill switch active. Waiting...');
            continue;
        }

        // Refresh capital
        const acc = await execution.getAccount();
        if (acc.equity > 0) capital = acc.equity;

        // Kill switch check
        const killCheck = risk.checkKillSwitch(capital, initialCapital);
        if (killCheck.halt) {
            halted = true;
            console.log(`[ML] ⚠️ KILL SWITCH: ${killCheck.reason}`);
            continue;
        }

        // Process each symbol
        for (const tick of ticks) {
            await processTick(tick);
        }

        // Check open positions for exits
        await checkExits(ticks);

        // Post-exit follow-up checks (uses current tick prices)
        const mlPriceMap = {};
        for (const tick of ticks) {
            if (tick?.symbol && tick?.price > 0) mlPriceMap[tick.symbol] = tick.price;
        }
        if (Object.keys(mlPriceMap).length) {
            postExitTracker.processDue(mlPriceMap, ['ml-pipeline'], {});
        }
    }
}

async function processTick(tick) {
    try {
        // 1. Sentiment
        const sent = await sentiment.fetchAndScore(tick.symbol);

        // 2. Features
        const feat = features.compute(tick, sent.score);

        // 3. Regime
        const reg = regime.detect(feat);

        // 4. ML Model → probability
        const probability = model.predict(feat, reg.bias);

        // 5. RL Agent recommendation
        const rlAction = rlAgent.chooseAction(feat, reg.regime);

        // 6. Signal from ML model
        const sig = signal.generate(probability);

        // 7. Combined decision: ML signal + RL must agree, or at least not contradict
        let finalSignal = sig.signal;
        if (sig.signal === 'BUY' && rlAction === 'SELL') finalSignal = 'HOLD'; // conflict
        if (sig.signal === 'SELL' && rlAction === 'BUY') finalSignal = 'HOLD'; // conflict
        if (sig.signal === 'HOLD' && rlAction !== 'HOLD') {
            // RL is more aggressive — only follow if confidence is marginal
            if (probability > 0.6 && rlAction === 'BUY') finalSignal = 'BUY';
            if (probability < 0.4 && rlAction === 'SELL') finalSignal = 'SELL';
        }

        // 8. Risk: position sizing
        const posSize = risk.size(capital, feat.volatility * tick.price);

        // 9. Execute
        if (finalSignal === 'BUY' && !openPositions[tick.symbol] && posSize > 0) {
            const result = await execution.executeBuy(tick.symbol, posSize, tick.price);
            if (result.success) {
                openPositions[tick.symbol] = {
                    entryPrice: tick.price,
                    size: posSize,
                    features: feat,
                    regime: reg.regime,
                    probability,
                    timestamp: Date.now(),
                };
                logTrade('BUY', tick.symbol, feat, probability, reg, null);
                tradeJournal.recordEntry({
                    symbol: tick.symbol, side: 'buy', qty: posSize, price: tick.price,
                    strategy: 'ml-pipeline', tier: 'MEDIUM', score: probability * 10,
                    signals: { momentum: feat.momentum, volumeSpike: feat.volumeSpike, sentiment: feat.sentiment },
                    indicators: { regime: reg.regime, probability, rlAction },
                    reason: `ML p=${probability} regime=${reg.regime} RL=${rlAction}`,
                });
                console.log(`[ML] 🟢 BUY ${tick.symbol} — p=${probability} regime=${reg.regime} size=${posSize}`);
            }
        } else if (finalSignal === 'SELL' && openPositions[tick.symbol]) {
            const pos = openPositions[tick.symbol];
            const result = await execution.executeSell(tick.symbol, pos.size, tick.price);
            if (result.success) {
                const pnlPct = ((tick.price - pos.entryPrice) / pos.entryPrice) * 100;
                const reward = rlAgent.pnlToReward(pnlPct);

                // RL update
                rlAgent.update(pos.features, pos.regime, 'BUY', reward, feat, reg.regime);
                // ML model update: target = 1 if profitable, 0 if not
                model.update(pos.features, pos.regime === 'BULL' ? 0.25 : pos.regime === 'BEAR' ? -0.25 : 0,
                    pnlPct > 0 ? 1 : 0);

                logTrade('SELL', tick.symbol, feat, probability, reg, pnlPct);
                tradeJournal.recordExit(tick.symbol, tick.price, `ML exit: p=${probability} pnl=${pnlPct.toFixed(1)}%`);
                delete openPositions[tick.symbol];
                console.log(`[ML] 🔴 SELL ${tick.symbol} — pnl=${pnlPct.toFixed(2)}% reward=${reward}`);
            }
        }
    } catch (err) {
        console.error(`[ML] processTick error for ${tick?.symbol}: ${err.message}`, err.stack);
    }
}

async function checkExits(ticks) {
    // Auto-exit positions held > 4 hours with negative momentum
    const now = Date.now();
    for (const [symbol, pos] of Object.entries(openPositions)) {
        const holdTime = (now - pos.timestamp) / (1000 * 60 * 60); // hours
        const tick = ticks.find(t => t.symbol === symbol);
        if (!tick) continue;

        const pnlPct = ((tick.price - pos.entryPrice) / pos.entryPrice) * 100;

        // Stop loss: -5%
        // Take profit: +8%
        // Time stop: 4hrs with negative P&L
        const shouldExit = pnlPct < -5 || pnlPct > 8 || (holdTime > 4 && pnlPct < 0);

        if (shouldExit) {
            const result = await execution.executeSell(symbol, pos.size, tick.price);
            if (result.success) {
                const feat = features.compute(tick, 0);
                const reg = regime.detect(feat);
                const reward = rlAgent.pnlToReward(pnlPct);
                rlAgent.update(pos.features, pos.regime, 'BUY', reward, feat, reg.regime);
                model.update(pos.features, pos.regime === 'BULL' ? 0.25 : -0.25, pnlPct > 0 ? 1 : 0);
                tradeJournal.recordExit(symbol, tick.price,
                    pnlPct < -5 ? 'ML stop loss' : pnlPct > 8 ? 'ML take profit' : 'ML time stop');
                delete openPositions[symbol];
                console.log(`[ML] ⏹️ EXIT ${symbol} — ${pnlPct.toFixed(2)}% (${pnlPct < -5 ? 'stop' : pnlPct > 8 ? 'TP' : 'time'})`);
            }
        }
    }
}

function logTrade(action, symbol, feat, probability, reg, pnl) {
    const entry = {
        timestamp: new Date().toISOString(),
        symbol,
        action,
        features: { momentum: feat.momentum, volumeSpike: feat.volumeSpike, sentiment: feat.sentiment, volatility: feat.volatility },
        probability,
        regime: reg.regime,
        pnl: pnl !== null ? parseFloat(pnl.toFixed(2)) : null,
    };
    tradeLog.push(entry);
    if (tradeLog.length > 500) tradeLog.shift();
}

function getTradeLog() { return tradeLog; }
function getOpenPositions() { return openPositions; }
function isHalted() { return halted; }
function resetHalt() { halted = false; risk.reset(capital); }

module.exports = { run, getTradeLog, getOpenPositions, isHalted, resetHalt };
