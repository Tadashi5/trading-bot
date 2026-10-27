require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType } = require('discord.js');
const cron = require('node-cron');

let client          = null;
let getLastData     = null;
let getLastAsia     = null;
let getLastPolitico = null;
let getLastWheel    = null;
let getLastRisky    = null;
let getLastMexc     = null;
let getLastMl       = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const ch = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v}%`);
const price = (v, dec = 2) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`);

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// ── Embed builders ────────────────────────────────────────────────────────────

function statusEmbeds(data) {
    const e = new EmbedBuilder()
        .setTitle('📊 Trading Suite — Status')
        .setColor(data?.account && parseFloat(data.account.pl) >= 0 ? 0x00ff88 : 0xff4444)
        .setTimestamp();

    if (data?.account) {
        e.addFields(
            { name: 'Cash',        value: `$${data.account.cash}`,      inline: true },
            { name: 'Portfolio',   value: `$${data.account.portfolio}`, inline: true },
            { name: "Today's P&L", value: `${parseFloat(data.account.pl) >= 0 ? '+' : ''}$${data.account.pl}`, inline: true },
        );
    } else {
        e.setDescription('No data yet — first scan runs at startup.');
    }

    if (data?.fearGreed) {
        e.addFields({ name: '😱 Fear & Greed', value: `${data.fearGreed.value} — **${data.fearGreed.label}**`, inline: true });
    }

    if (data?.lastScan) e.setFooter({ text: `Last scan: ${data.lastScan} · Scans every 5 min` });
    return [e];
}

function signalEmbeds(data) {
    const rows = [];
    (data?.crypto || []).filter(r => r.signal !== 'HOLD').forEach(r =>
        rows.push(`${r.signal === 'BUY' ? '🟢' : r.signal === 'SELL' ? '🔴' : '🟡'} **${r.name}** — ${r.signal} | Score: ${r.score} | ${ch(parseFloat(r.change))}`)
    );
    (data?.stocks || []).filter(r => r.signal !== 'HOLD').forEach(r =>
        rows.push(`${r.signal === 'BUY' ? '🟢' : r.signal === 'SELL' ? '🔴' : '🟡'} **$${r.ticker}** — ${r.signal} | Score: ${r.totalScore}`)
    );
    (data?.options || []).filter(r => r.signal !== 'WAIT').forEach(r =>
        rows.push(`📋 **$${r.ticker}** — ${r.signal} | Score: ${r.totalScore}`)
    );

    const e = new EmbedBuilder()
        .setTitle('📡 Active Signals')
        .setColor(0xa855f7)
        .setDescription(rows.length ? rows.join('\n') : 'No active signals — all HOLD / WAIT.')
        .setTimestamp();
    if (data?.lastScan) e.setFooter({ text: `Last scan: ${data.lastScan}` });
    return [e];
}

function asiaEmbeds(asia) {
    if (!asia) return [new EmbedBuilder().setTitle('🌏 Global Markets').setColor(0x888888).setDescription('Data not loaded yet — runs every 15 minutes.')];

    const embeds = [];

    // ── Index snapshot ────────────────────────────────────────────────────────
    const e = new EmbedBuilder().setTitle('🌏 Global Markets Snapshot').setColor(0xf59e0b).setTimestamp();

    if (asia.us) {
        const u = asia.us;
        const parts = [
            u.spy ? `SPY ${ch(u.spy.change)}` : '',
            u.qqq ? `QQQ ${ch(u.qqq.change)}` : '',
            u.vix ? `VIX ${u.vix.price?.toFixed(1)}` : '',
        ].filter(Boolean);
        if (parts.length) e.addFields({ name: '🇺🇸 US Baseline', value: parts.join('  ·  '), inline: false });
    }

    for (const key of ['au', 'jp', 'cn', 'uk']) {
        const m = asia[key];
        if (!m?.index) continue;
        const idx = m.index;
        const corrStr = m.correlation?.label ? `Corr/SPY: **${m.correlation.label}**` : '';
        const sentStr = m.newsScore > 0 ? '📈 Bullish' : m.newsScore < 0 ? '📉 Bearish' : '➡️ Neutral';
        e.addFields({
            name: `${m.flag} ${m.market}`,
            value: [
                idx.price ? `${idx.price.toLocaleString()} (${ch(idx.change)})` : 'Data unavailable',
                corrStr,
                `Sentiment: ${sentStr}`,
            ].filter(Boolean).join('  ·  '),
            inline: true,
        });
    }

    if (asia.scannedAt) e.setFooter({ text: `Scan: ${asia.scannedAt} · Refreshes every 15 min` });
    embeds.push(e);

    // ── Asian paper trader ────────────────────────────────────────────────────
    const paper = asia.paper;
    if (paper) {
        const pe = new EmbedBuilder().setTitle('📋 International Paper Trader').setColor(0x2dd4bf).setTimestamp();
        const stats = paper.stats || {};
        pe.addFields(
            { name: 'Portfolio', value: `$${stats.portfolioValue ?? '—'}`, inline: true },
            { name: 'Return',    value: `${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturn ?? 0}%`, inline: true },
            { name: 'Win Rate',  value: `${stats.winRate ?? 0}%  (${stats.wins ?? 0}W / ${stats.losses ?? 0}L)`, inline: true },
        );

        const positions = paper.positions || [];
        if (positions.length) {
            const flags = { au: '🇦🇺', jp: '🇯🇵', cn: '🇨🇳', uk: '🇬🇧' };
            const lines = positions.slice(0, 10).map(p => {
                const pnl = p.pnlPct >= 0 ? `+${p.pnlPct}%` : `${p.pnlPct}%`;
                return `${flags[p.market] || ''}**${p.symbol}** ${p.name} — ${pnl}`;
            });
            pe.setDescription(lines.join('\n'));
        } else {
            pe.setDescription('No open positions');
        }
        embeds.push(pe);
    }

    return embeds;
}

function reportEmbeds(data, asia) {
    const embeds = [];

    // ── Main account embed ────────────────────────────────────────────────────
    const main = new EmbedBuilder()
        .setTitle('📊 Trading Suite — Daily Report')
        .setColor(data?.account && parseFloat(data.account.pl) >= 0 ? 0x00ff88 : 0xff4444)
        .setTimestamp()
        .setFooter({ text: 'Trading Suite • Alpaca Paper Trading' });

    if (data?.account) {
        main.addFields(
            { name: 'Cash',        value: `$${data.account.cash}`,      inline: true },
            { name: 'Portfolio',   value: `$${data.account.portfolio}`, inline: true },
            { name: "Today's P&L", value: `${parseFloat(data.account.pl) >= 0 ? '+' : ''}$${data.account.pl}`, inline: true },
        );
    }
    if (data?.fearGreed) {
        main.addFields({ name: '😱 Fear & Greed', value: `**${data.fearGreed.value}** — ${data.fearGreed.label}`, inline: true });
    }
    embeds.push(main);

    // ── Markets overview ──────────────────────────────────────────────────────
    if (asia) {
        const mkt = new EmbedBuilder().setTitle('🌐 Markets Overview').setColor(0x4488ff);
        const u = asia.us;
        if (u) {
            mkt.addFields({ name: '🇺🇸 US Markets', value: [
                u.spy ? `SPY: ${price(u.spy.price, 0)} (${ch(u.spy.change)})` : '',
                u.qqq ? `QQQ: ${price(u.qqq.price, 0)} (${ch(u.qqq.change)})` : '',
                u.dji ? `Dow: ${price(u.dji.price, 0)} (${ch(u.dji.change)})` : '',
                u.vix ? `VIX: ${u.vix.price?.toFixed(1)}` : '',
            ].filter(Boolean).join('  ·  ') || '—' });
        }
        for (const [key, label] of [['au', '🇦🇺 Australia'], ['jp', '🇯🇵 Japan'], ['cn', '🇭🇰 China / HK']]) {
            const m = asia[key];
            if (!m?.index) continue;
            mkt.addFields({ name: `${label} — ${m.index.name}`, value:
                `${m.index.price?.toLocaleString() || '—'} (${ch(m.index.change)})  ·  Corr/SPY: **${m.correlation?.label || 'N/A'}**  ·  Sentiment: ${m.newsScore > 0 ? '📈' : m.newsScore < 0 ? '📉' : '➡️'} ${m.newsScore}`,
            });
        }
        embeds.push(mkt);
    }

    // ── Active signals ────────────────────────────────────────────────────────
    const sigs = [];
    (data?.crypto || []).filter(r => r.signal !== 'HOLD').slice(0, 6).forEach(r =>
        sigs.push(`${r.signal === 'BUY' ? '🟢' : r.signal === 'SELL' ? '🔴' : '🟡'} **${r.name}** — ${r.signal} ${ch(parseFloat(r.change))}`)
    );
    (data?.stocks || []).filter(r => r.signal !== 'HOLD').slice(0, 6).forEach(r =>
        sigs.push(`${r.signal === 'BUY' ? '🟢' : r.signal === 'SELL' ? '🔴' : '🟡'} **$${r.ticker}** — ${r.signal}`)
    );
    if (sigs.length) {
        embeds.push(new EmbedBuilder().setTitle('📡 Active Signals').setColor(0xa855f7).setDescription(sigs.join('\n')));
    }

    // ── Risk tier overview ────────────────────────────────────────────────────
    const rd = getLastRisky?.();
    if (rd?.riskStatus) {
        const rs = rd.riskStatus;
        const re = new EmbedBuilder().setTitle('🎯 Risk Allocation').setColor(0xf59e0b);
        re.addFields(
            { name: '🟢 LOW',    value: `$${rs.exposure.low.toFixed(0)} / $${rs.targets_abs.low.toFixed(0)} (${rs.pctUsed.low.toFixed(0)}%)`,    inline: true },
            { name: '🟡 MEDIUM', value: `$${rs.exposure.medium.toFixed(0)} / $${rs.targets_abs.medium.toFixed(0)} (${rs.pctUsed.medium.toFixed(0)}%)`, inline: true },
            { name: '🔴 HIGH',   value: `$${rs.exposure.high.toFixed(0)} / $${rs.targets_abs.high.toFixed(0)} (${rs.pctUsed.high.toFixed(0)}%)`,   inline: true },
        );
        embeds.push(re);
    }

    // ── Wheel strategy summary ────────────────────────────────────────────────
    const wd = getLastWheel?.();
    if (wd?.totalPremium > 0) {
        const wActive = (wd.results || []).filter(r => r.contract || r.stage === 2);
        const we = new EmbedBuilder().setTitle('🎡 Wheel Strategy').setColor(0x6366f1);
        we.addFields(
            { name: 'All-time Premium', value: `$${wd.totalPremium.toFixed(2)}`,    inline: true },
            { name: 'Active Positions', value: `${wActive.length}`,                 inline: true },
        );
        if (wActive.length) {
            const lines = wActive.slice(0, 8).map(r => {
                const c = r.contract;
                return c
                    ? `${c.type === 'put' ? '📉' : '📈'} **${r.ticker}** Stage ${r.stage} | ${c.type.toUpperCase()} $${c.strike} exp ${c.expiry}`
                    : `⏳ **${r.ticker}** Stage ${r.stage}`;
            });
            we.setDescription(lines.join('\n'));
        }
        embeds.push(we);
    }

    // ── Research bias ─────────────────────────────────────────────────────────
    if (data?.research?.summary && data.research.summary !== '(report stale)') {
        const r = data.research;
        const re = new EmbedBuilder().setTitle('🔬 Research Context').setColor(0x7c3aed);
        re.addFields(
            { name: 'Sentiment', value: r.sentiment || '—', inline: true },
            { name: 'Crypto View', value: r.cryptoView || '—', inline: true },
            { name: 'VIX View', value: r.vixView || '—', inline: true },
        );
        if (r.summary) re.setDescription(`*"${r.summary}"*`);
        embeds.push(re);
    }

    return embeds;
}

// ── Risk tier allocation embed ────────────────────────────────────────────────

function riskEmbeds(riskyData) {
    const rs  = riskyData?.riskStatus;
    const bar = (pct) => {
        const filled = Math.round(Math.min(pct, 100) / 10);
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct.toFixed(0)}%`;
    };

    const e = new EmbedBuilder()
        .setTitle('🎯 Risk Tier Allocation')
        .setColor(0xf59e0b)
        .setTimestamp();

    if (!rs) {
        e.setDescription('No risk data yet — runs at startup and every 5 min during market hours.');
        return [e];
    }

    const pv = rs.portfolioValue;
    e.setDescription(`**Portfolio:** $${pv.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

    e.addFields(
        {
            name: `🟢 LOW (target ${(rs.targets.low * 100).toFixed(0)}% · $${rs.targets_abs.low.toFixed(0)})`,
            value: `${bar(rs.pctUsed.low)}  ·  $${rs.exposure.low.toFixed(0)} used  ·  $${rs.available.low.toFixed(0)} avail\n*Wheel strategy: CSPs + Covered Calls*`,
            inline: false,
        },
        {
            name: `🟡 MEDIUM (target ${(rs.targets.medium * 100).toFixed(0)}% · $${rs.targets_abs.medium.toFixed(0)})`,
            value: `${bar(rs.pctUsed.medium)}  ·  $${rs.exposure.medium.toFixed(0)} used  ·  $${rs.available.medium.toFixed(0)} avail\n*Stocks, Crypto, Options*`,
            inline: false,
        },
        {
            name: `🔴 HIGH (target ${(rs.targets.high * 100).toFixed(0)}% · $${rs.targets_abs.high.toFixed(0)})`,
            value: `${bar(rs.pctUsed.high)}  ·  $${rs.exposure.high.toFixed(0)} used  ·  $${rs.available.high.toFixed(0)} avail\n*Leveraged ETFs + Meme stocks*`,
            inline: false,
        },
    );

    const embeds = [e];

    // Active high-risk positions
    const riskyResults = riskyData?.results || [];
    const active = riskyResults.filter(r => r.unrealizedPct !== null);
    if (active.length) {
        const lines = active.map(r =>
            `${r.type === 'leveraged' ? '⚡' : '🎰'} **${r.ticker}** ${r.name} | P&L: ${parseFloat(r.unrealizedPct) >= 0 ? '+' : ''}${r.unrealizedPct}% | RSI: ${r.rsi ?? '—'} | Score: ${r.score}`
        );
        embeds.push(
            new EmbedBuilder()
                .setTitle('🎲 Active High-Risk Positions')
                .setColor(0xef4444)
                .setDescription(lines.join('\n'))
        );
    }

    return embeds;
}

// ── Wheel strategy embed ──────────────────────────────────────────────────────

function wheelEmbeds(wheelData) {
    if (!wheelData) {
        return [new EmbedBuilder()
            .setTitle('🎡 Wheel Strategy')
            .setColor(0x888888)
            .setDescription('No data yet — wheel scan runs every 15 min during market hours.')];
    }

    const embeds = [];
    const { results = [], totalPremium = 0, cash = 0 } = wheelData;

    const header = new EmbedBuilder()
        .setTitle('🎡 Wheel Strategy — Status')
        .setColor(0x6366f1)
        .setTimestamp()
        .addFields(
            { name: 'All-time Premium', value: `$${totalPremium.toFixed(2)}`, inline: true },
            { name: 'Available Cash',   value: `$${cash.toFixed(2)}`,         inline: true },
        )
        .setFooter({ text: 'Scans every 15 min during market hours · Stage 1 = selling puts · Stage 2 = covered calls' });

    const active = results.filter(r => r.contract || r.stage === 2 || r.totalCycles > 0);
    if (active.length) {
        const byMarket = { usa: [], aus: [], jpn: [], chn: [] };
        for (const r of active) {
            const mkt = r.market || 'usa';
            const c   = r.contract;
            const tag = c
                ? `${c.type === 'put' ? '📉' : '📈'} **$${r.ticker}** Stage ${r.stage} | ${c.type.toUpperCase()} strike $${c.strike} exp ${c.expiry}`
                : `⏳ **$${r.ticker}** Stage ${r.stage} — waiting for new contract`;
            (byMarket[mkt] || byMarket.usa).push(tag);
        }

        for (const [mkt, lines] of Object.entries(byMarket)) {
            if (!lines.length) continue;
            const labels = { usa: '🇺🇸 USA', aus: '🇦🇺 AUS', jpn: '🇯🇵 JPN', chn: '🇨🇳 CHN' };
            embeds.push(
                new EmbedBuilder()
                    .setTitle(`🎡 Wheel — ${labels[mkt]}`)
                    .setColor(0x6366f1)
                    .setDescription(lines.join('\n'))
            );
        }
    } else {
        header.setDescription('No active positions yet — opening CSPs on first market-hours scan.');
    }

    embeds.unshift(header);
    return embeds;
}

// ── VIP congressional traders embed ───────────────────────────────────────────

function vipEmbeds(vipData) {
    if (!vipData || !vipData.vips || !Object.keys(vipData.vips).length) {
        return [new EmbedBuilder()
            .setTitle('🏛️ VIP Congressional Traders')
            .setColor(0x888888)
            .setDescription('No VIP data yet — builds after first politico scan.')];
    }

    const embeds = [];
    const colors = [0xa855f7, 0xef4444, 0x00ff88, 0xf59e0b, 0x3b82f6];
    let idx = 0;

    for (const [name, vip] of Object.entries(vipData.vips)) {
        if (!vip.active) continue;
        const s = vip.stats || {};
        const trades = (vip.trades || []).slice(-5).reverse();

        const tradeLines = trades.map(t => {
            const ret = t.pctReturn != null ? (t.pctReturn >= 0 ? '+' : '') + t.pctReturn + '%' : '?';
            const tag = t.autoBought ? ' ✅' : t.validated ? ' ⚡' : ' ❌';
            return `$${t.ticker} (${t.date?.slice(0, 10)}) → ${ret}${tag}`;
        });

        const e = new EmbedBuilder()
            .setTitle(`${name} (${vip.party || '?'})`)
            .setColor(colors[idx % colors.length])
            .addFields(
                { name: 'Trades', value: `${s.totalTrades || 0}`, inline: true },
                { name: 'Win Rate', value: `${s.winRate || 0}%`, inline: true },
                { name: 'Avg Return', value: `${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn || 0}%`, inline: true },
            );

        if (tradeLines.length) {
            e.setDescription(tradeLines.join('\n'));
        } else {
            e.setDescription('No recent trades');
        }

        embeds.push(e);
        idx++;
    }

    embeds.unshift(
        new EmbedBuilder()
            .setTitle('🏛️ Top 5 Congressional Traders — VIP Tracker')
            .setColor(0x6366f1)
            .setTimestamp()
            .setDescription('Performance of tracked VIP politicians\' stock picks.\n✅ = auto-bought  ⚡ = validated  ❌ = skipped')
            .setFooter({ text: `Last update: ${vipData.lastUpdate?.slice(0, 16) || '—'} · Scans every 3h` })
    );

    return embeds;
}

// ── Morning politico briefing embed ──────────────────────────────────────────

function politicoBriefingEmbeds(politicoData) {
    const embeds = [];

    const hot   = politicoData?.hotSignals    || [];
    const top   = politicoData?.topPoliticians || [];
    const acted = politicoData?.autoTraded    || {};
    const count = politicoData?.recentBuyCount || 0;
    const scan  = politicoData?.scannedAt     || '—';

    // ── Header embed ─────────────────────────────────────────────────────────
    const header = new EmbedBuilder()
        .setTitle('🏛️ Congressional Trade Briefing — 10am Melbourne')
        .setColor(0xf59e0b)
        .setTimestamp()
        .setDescription(`**${count}** congressional buys tracked in the last 30 days · Last scan: ${scan}`)
        .setFooter({ text: 'Source: Capitol Trades · Hot = 5+ politicians on same ticker' });
    embeds.push(header);

    // ── Hot signals ───────────────────────────────────────────────────────────
    if (hot.length) {
        const lines = hot.slice(0, 10).map(s => {
            const portfolio = s.inPortfolio ? `📂 held (${s.unrealizedPct}%)` : '—';
            const autoTag   = acted[s.ticker] ? '✅ auto-bought' : '⚡ potential buy';
            return `🔥 **$${s.ticker}** — ${s.count} politicians · ${autoTag} · ${portfolio}`;
        });
        embeds.push(
            new EmbedBuilder()
                .setTitle('🔥 Hot Signals (5+ Politicians)')
                .setColor(0xef4444)
                .setDescription(lines.join('\n'))
        );
    } else {
        embeds.push(
            new EmbedBuilder()
                .setTitle('🔥 Hot Signals')
                .setColor(0x888888)
                .setDescription('No hot signals right now — no ticker has 5+ congressional buyers in the last 30 days.')
        );
    }

    // ── Top politicians ───────────────────────────────────────────────────────
    if (top.length) {
        const lines = top.slice(0, 10).map((p, i) =>
            `**${i + 1}.** ${p.name} (${p.party || '?'}) — ${p.buyCount} buys · ${p.tickers || '—'}`
        );
        embeds.push(
            new EmbedBuilder()
                .setTitle('👤 Most Active Buyers (Top 10)')
                .setColor(0x6366f1)
                .setDescription(lines.join('\n'))
        );
    }

    return embeds;
}

// ── MEXC paper trader embeds ─────────────────────────────────────────────────

function mexcEmbeds(mexcData) {
    if (!mexcData?.paper) return [new EmbedBuilder().setTitle('🎰 MEXC Alt/Defi Paper Trader').setColor(0x888888).setDescription('No data yet — scans every minute.')];

    const paper = mexcData.paper;
    const stats = paper.stats || {};
    const embeds = [];

    const main = new EmbedBuilder()
        .setTitle('🎰 MEXC Alt/Defi Paper Trader')
        .setColor(stats.totalReturn >= 0 ? 0x00ff88 : 0xff4444)
        .setTimestamp()
        .addFields(
            { name: 'Balance',    value: `$${paper.balance?.toFixed(0) ?? '—'}`, inline: true },
            { name: 'Return',     value: `${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturn ?? 0}%`, inline: true },
            { name: 'Win Rate',   value: `${stats.winRate ?? 0}%  (${stats.wins ?? 0}W / ${stats.losses ?? 0}L)`, inline: true },
            { name: 'Total Trades', value: `${stats.trades ?? 0}`, inline: true },
            { name: 'Total P&L',  value: `$${stats.totalPnl?.toFixed(2) ?? '0'}`, inline: true },
            { name: 'Scanned',    value: `${paper.hotMoversScanned ?? 0} hot movers`, inline: true },
        );

    const positions = paper.positions || [];
    if (positions.length) {
        const lines = positions.slice(0, 12).map(p =>
            `${p.pnlPct >= 0 ? '🟢' : '🔴'} **${p.symbol}** +${p.entryMomentum?.toFixed(0) ?? '?'}% entry · P&L: ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%`
        );
        main.setDescription(`**Open Positions (${positions.length})**\n${lines.join('\n')}`);
    }
    embeds.push(main);

    const recent = paper.closedRecent || [];
    if (recent.length) {
        const lines = recent.slice(-8).reverse().map(t =>
            `${t.pnlPct >= 0 ? '✅' : '❌'} **${t.symbol}** ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}% ($${t.pnlDollar?.toFixed(2)}) — ${t.reason}`
        );
        embeds.push(new EmbedBuilder()
            .setTitle('🎰 MEXC — Recent Closed Trades')
            .setColor(0xf59e0b)
            .setDescription(lines.join('\n')));
    }

    // Alpaca bridge trades
    const bridged = paper.bridgedTrades || [];
    if (bridged.length) {
        const lines = bridged.map(b => `🌉 **${b.symbol}** → Alpaca ${b.alpacaSymbol} $${b.notional?.toFixed(0)} (score ${b.score?.toFixed(1)})`);
        embeds.push(new EmbedBuilder()
            .setTitle('🌉 MEXC→Alpaca Bridge')
            .setColor(0x6366f1)
            .setDescription(lines.join('\n')));
    }

    return embeds;
}

// ── ML pipeline embeds ────────────────────────────────────────────────────────

function mlEmbeds(ml) {
    if (!ml) return [new EmbedBuilder().setTitle('🤖 ML/RL Pipeline').setColor(0x888888).setDescription('No ML data yet.')];

    const embeds = [];
    let openPositions = [], tradeLog = [], halted = false, rlStats = null;

    try {
        openPositions = ml.getOpenPositions?.() || [];
        tradeLog      = ml.getTradeLog?.()      || [];
        halted        = ml.isHalted?.()         || false;
    } catch {}

    try {
        const rlAgent = require('./src/ml/rlAgent');
        rlStats = rlAgent.getStats?.() || null;
    } catch {}

    const main = new EmbedBuilder()
        .setTitle(`🤖 ML/RL Pipeline${halted ? ' — ⛔ HALTED' : ''}`)
        .setColor(halted ? 0xff4444 : 0xa855f7)
        .setTimestamp();

    if (openPositions.length) {
        const lines = openPositions.slice(0, 8).map(p => {
            const pnl = p.unrealizedPct != null ? ` · P&L: ${p.unrealizedPct >= 0 ? '+' : ''}${p.unrealizedPct?.toFixed(1)}%` : '';
            return `🟣 **${p.symbol}** $${p.notional?.toFixed(0)} @ $${p.entryPrice?.toFixed(2)}${pnl}`;
        });
        main.addFields({ name: `Open Positions (${openPositions.length})`, value: lines.join('\n'), inline: false });
    } else {
        main.addFields({ name: 'Open Positions', value: 'None', inline: true });
    }

    if (rlStats) {
        main.addFields(
            { name: 'RL Episodes',  value: `${rlStats.episodes ?? 0}`, inline: true },
            { name: 'RL Wins',      value: `${rlStats.wins ?? 0}`, inline: true },
            { name: 'RL Win Rate',  value: `${rlStats.winRate?.toFixed(1) ?? 0}%`, inline: true },
        );
    }
    embeds.push(main);

    const recent = tradeLog.slice(-8).reverse();
    if (recent.length) {
        const lines = recent.map(t =>
            `${t.pnl >= 0 ? '✅' : '❌'} **${t.symbol}** ${t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)}% · ${t.regime ?? '?'} regime`
        );
        embeds.push(new EmbedBuilder()
            .setTitle('🤖 ML — Recent Trades')
            .setColor(0x6366f1)
            .setDescription(lines.join('\n')));
    }

    return embeds;
}

// ── Send to channel ───────────────────────────────────────────────────────────

async function sendToChannel(embeds) {
    if (!client || !process.env.DISCORD_CHANNEL_ID) return;
    try {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        for (const batch of chunk(embeds, 10)) await channel.send({ embeds: batch });
    } catch (err) {
        console.log('[Discord] Send error:', err.message);
    }
}

// ── Bot init ──────────────────────────────────────────────────────────────────

function init(getData, getAsia, getPolitico, getWheel, getRisky, getMexc, getMl) {
    if (!process.env.DISCORD_BOT_TOKEN) {
        console.log('[Discord] DISCORD_BOT_TOKEN not set — bot disabled. Add it to .env to enable.');
        return;
    }

    getLastData     = getData;
    getLastAsia     = getAsia;
    getLastPolitico = getPolitico;
    getLastWheel    = getWheel;
    getLastRisky    = getRisky;
    getLastMexc     = getMexc;
    getLastMl       = getMl;

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    client.once(Events.ClientReady, c => {
        console.log(`[Discord] Logged in as ${c.user.tag}`);
        c.user.setActivity('markets', { type: ActivityType.Watching });

        // Daily report — ~7am Melbourne (20:30 UTC splits AEST/AEDT)
        cron.schedule('30 20 * * 1-5', async () => {
            console.log('[Discord] Sending daily report...');
            const allEmbeds = [
                ...reportEmbeds(getLastData?.(), getLastAsia?.()),
                ...asiaEmbeds(getLastAsia?.()),
                ...mexcEmbeds(getLastMexc?.()),
                ...mlEmbeds(getLastMl?.()),
            ];
            for (const batch of chunk(allEmbeds, 10)) await sendToChannel(batch);
        });

        // 10am Melbourne congressional briefing (0:00 UTC = 10am AEST / 11am AEDT — close enough)
        cron.schedule('0 0 * * 1-5', async () => {
            console.log('[Discord] Sending 10am Melbourne congressional briefing...');
            await sendToChannel(politicoBriefingEmbeds(getLastPolitico?.()));
        });

        console.log('[Discord] Daily report ~7am Melbourne + congressional briefing ~10am Melbourne (weekdays)');
    });

    client.on(Events.MessageCreate, async msg => {
        if (msg.author.bot || !msg.content.startsWith('!')) return;
        const cmd = msg.content.trim().toLowerCase().split(/\s+/)[0];
        const data = getLastData?.();
        const asia = getLastAsia?.();

        try {
            switch (cmd) {
                case '!help':
                    await msg.reply([
                        '**📟 Trading Suite Commands**',
                        '`!status`   — Account balance + P&L',
                        '`!signals`  — Active buy/sell signals',
                        '`!asia`     — Global markets + international paper trader (AU/JP/CN/UK)',
                        '`!mexc`     — MEXC alt/defi paper trader positions + stats',
                        '`!ml`       — ML/RL pipeline positions + trade log',
                        '`!politico` — Congressional trade briefing',
                        '`!wheel`    — Wheel strategy positions + premium',
                        '`!vips`     — Top 5 congressional traders + performance',
                        '`!risk`     — Capital allocation across LOW / MEDIUM / HIGH tiers',
                        '`!journal`  — Trade journal stats + learned weights',
                        '`!learning` — Is the bot actually learning? Weights drift + RL Q-table progress',
                        '`!missed`   — Missed runners: positions we sold too early + what changed',
                        '`!performance` — Equity curve across all markets: return, 24h, max drawdown',
                        '`!report`   — Full daily report (everything)',
                        '`!scan`     — Last scan time',
                    ].join('\n'));
                    break;

                case '!status':
                    await msg.channel.send({ embeds: statusEmbeds(data) });
                    break;

                case '!signals':
                case '!positions':
                    await msg.channel.send({ embeds: signalEmbeds(data) });
                    break;

                case '!asia':
                    await msg.channel.send({ embeds: asiaEmbeds(asia) });
                    break;

                case '!report': {
                    const allEmbeds = [
                        ...reportEmbeds(data, asia),
                        ...asiaEmbeds(asia),
                        ...mexcEmbeds(getLastMexc?.()),
                        ...mlEmbeds(getLastMl?.()),
                    ];
                    for (const batch of chunk(allEmbeds, 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!politico': {
                    const pd = getLastPolitico?.();
                    for (const batch of chunk(politicoBriefingEmbeds(pd), 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!wheel': {
                    const wd = getLastWheel?.();
                    for (const batch of chunk(wheelEmbeds(wd), 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!risk': {
                    const rd = getLastRisky?.();
                    for (const batch of chunk(riskEmbeds(rd), 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!vips': {
                    const pd = getLastPolitico?.();
                    const vd = pd?.vipData;
                    const embeds = vipEmbeds(vd);
                    for (const batch of chunk(embeds, 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!journal': {
                    const tradeJournal = require('./tradeJournal');
                    const stats = tradeJournal.getStats();
                    const weights = tradeJournal.loadWeights();
                    const topWeights = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 5);
                    const embed = new EmbedBuilder()
                        .setTitle('📓 Trade Journal')
                        .setColor(stats.winRate >= 55 ? 0x00ff88 : stats.winRate >= 45 ? 0xffaa00 : 0xff4444)
                        .addFields(
                            { name: 'Total Trades', value: `${stats.closedTotal || 0}`, inline: true },
                            { name: 'Win Rate', value: `${stats.winRate || 0}%`, inline: true },
                            { name: 'Total P&L', value: `$${stats.totalPnl || 0}`, inline: true },
                            { name: 'Avg Win', value: `${stats.avgWin || 0}%`, inline: true },
                            { name: 'Avg Loss', value: `${stats.avgLoss || 0}%`, inline: true },
                            { name: 'Open Trades', value: `${stats.openTrades || 0}`, inline: true },
                            { name: 'Top Signal Weights', value: topWeights.map(([k, v]) => `${k}: ${v}`).join('\n') || 'default (1.0)', inline: false },
                        )
                        .setFooter({ text: 'Weights auto-adjust every 10 closed trades' });
                    await msg.channel.send({ embeds: [embed] });
                    break;
                }

                case '!mexc': {
                    const md = getLastMexc?.();
                    for (const batch of chunk(mexcEmbeds(md), 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!ml': {
                    const ml = getLastMl?.();
                    for (const batch of chunk(mlEmbeds(ml), 10))
                        await msg.channel.send({ embeds: batch });
                    break;
                }

                case '!learning': {
                    const tj  = require('./tradeJournal');
                    const rl  = require('./src/ml/rlAgent');
                    const pet = require('./postExitTracker');
                    const DEFAULT_WEIGHT = 1.0;

                    const stats    = tj.getStats();
                    const weights  = tj.loadWeights();
                    const rlStats  = rl.getStats();
                    const petStats = pet.getStats();

                    // Which signals have drifted from default — proof of learning
                    const drifted = Object.entries(weights)
                        .map(([k, v]) => ({ k, v, delta: parseFloat((v - DEFAULT_WEIGHT).toFixed(3)) }))
                        .filter(x => Math.abs(x.delta) >= 0.01)
                        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

                    const byStrat = stats.byStrategy || {};
                    const stratLines = Object.entries(byStrat)
                        .map(([s, d]) => `${s}: ${d.trades} trades, ${d.winRate}% WR, $${d.pnl}`)
                        .join('\n') || 'No closed trades yet';

                    // Asian paper learnings
                    let asianLines = 'No data yet';
                    try {
                        const al = require('./asianPaperTrader').getState().learnings?.markets || {};
                        asianLines = Object.entries(al)
                            .map(([m, d]) => `${m.toUpperCase()}: ${d.trades} trades, ${d.winRate}% WR, avg ${d.avgReturn}%`)
                            .join('\n') || 'No closed trades yet';
                    } catch {}

                    // Post-exit follow-up summary
                    const exitAccLine = petStats.completed > 0
                        ? `${petStats.goodExits}/${petStats.completed} good exits (${petStats.exitAccuracy}%) · ${petStats.missedRunners} missed runners · avg left on table: ${petStats.avgMissedDrift}% · ${petStats.pending} pending checks`
                        : `No completed follow-ups yet · ${petStats.pending} pending`;

                    // Verdict
                    const hasLearned = drifted.length > 0 || rlStats.totalUpdates > 0 || petStats.completed > 0;
                    const verdict = stats.closedTotal < 5
                        ? `⏳ Building sample (${stats.closedTotal}/5 trades to trigger weight learning)`
                        : hasLearned
                            ? `✅ Actively learning — ${drifted.length} signals drifted · ${petStats.completed} post-exit checks done`
                            : '⚠️ Trades recorded but weights unchanged yet';

                    const embed = new EmbedBuilder()
                        .setTitle('🧠 Learning Status')
                        .setColor(hasLearned ? 0x00ff88 : 0xffaa00)
                        .setDescription(verdict)
                        .addFields(
                            { name: '📊 Trade Sample', value: `${stats.closedTotal || 0} closed · ${stats.openTrades || 0} open · Win rate: **${stats.winRate || 0}%**`, inline: false },
                            { name: '⚖️ Signal Weights Drifted', value: drifted.length
                                ? drifted.map(x => `${x.k}: ${x.v} (${x.delta > 0 ? '+' : ''}${x.delta})`).join('\n')
                                : 'All still at default (1.0) — need 5+ closed trades', inline: false },
                            { name: '🔍 Post-Exit Follow-up', value: exitAccLine, inline: false },
                            { name: '🤖 RL Q-Table', value: `${rlStats.statesExplored} states · ${rlStats.totalUpdates} updates · ε=${rlStats.epsilon}`, inline: false },
                            { name: '📈 By Strategy', value: stratLines, inline: false },
                            { name: '🌏 Asian Paper Markets', value: asianLines, inline: false },
                        )
                        .setFooter({ text: 'Weights update every 30 min or after 3 losses · Post-exit checks at +4h/24h/72h/7d' });
                    await msg.channel.send({ embeds: [embed] });
                    break;
                }

                case '!missed': {
                    const pet    = require('./postExitTracker');
                    const misses = pet.getMissedRunners(8);
                    const goods  = pet.getGoodExits(3);
                    const stats  = pet.getStats();

                    if (!misses.length && !goods.length) {
                        await msg.reply('No post-exit data yet — checks fire at +4h/24h/72h/7d after each close. Check back after the first trade completes its follow-up window.');
                        break;
                    }

                    const fields = [];

                    if (misses.length) {
                        const missLines = misses.map(e => {
                            // Find the checkpoint with the highest drift
                            const peakCp = e.checkpoints
                                .filter(cp => cp.drift != null)
                                .sort((a, b) => b.drift - a.drift)[0];
                            const peakHr = peakCp?.hoursAfter ?? '?';
                            const drift  = e.maxDrift?.toFixed(1) ?? '?';
                            const snap   = peakCp?.snapshot;

                            // Build "what changed" line from snapshot
                            const changed = [];
                            if (snap?.rsi != null)        changed.push(`RSI ${snap.rsi}`);
                            if (snap?.macdBullish != null) changed.push(`MACD ${snap.macdBullish ? '▲' : '▼'}`);
                            if (snap?.trend != null)       changed.push(`trend=${snap.trend}`);
                            if (snap?.newsScore != null && Math.abs(snap.newsScore) >= 2)
                                changed.push(`news ${snap.newsScore > 0 ? '📈' : '📉'}${snap.newsScore}`);

                            const exitSig = Object.entries(e.exitSignals || {})
                                .filter(([, v]) => typeof v === 'number' && Math.abs(v) >= 1)
                                .map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`)
                                .slice(0, 3).join(' ');

                            return [
                                `**${e.symbol}** — sold at **$${e.exitPrice?.toFixed(2)}**, ran **+${drift}%** by +${peakHr}h`,
                                `Exit reason: _${e.exitReason || 'unknown'}_`,
                                exitSig ? `Signals at exit: \`${exitSig}\`` : null,
                                changed.length ? `At +${peakHr}h: ${changed.join(', ')}` : null,
                            ].filter(Boolean).join('\n');
                        }).join('\n\n');

                        fields.push({ name: `⚠️ Missed Runners (${misses.length})`, value: missLines.slice(0, 1020) || '—', inline: false });
                    }

                    if (goods.length) {
                        const goodLines = goods.map(e => {
                            const lowestCp = e.checkpoints.filter(cp => cp.drift != null).sort((a, b) => a.drift - b.drift)[0];
                            return `**${e.symbol}** dropped **${e.maxDrift?.toFixed(1)}%** by +${lowestCp?.hoursAfter ?? '?'}h after exit — ✅ good call`;
                        }).join('\n');
                        fields.push({ name: `✅ Good Exits (${goods.length})`, value: goodLines.slice(0, 500) || '—', inline: false });
                    }

                    fields.push({
                        name: '📊 Overall Exit Accuracy',
                        value: `${stats.goodExits} good exits · ${stats.missedRunners} missed runners · ${stats.neutral} neutral · Exit accuracy: **${stats.exitAccuracy ?? '?'}%**\nAvg left on table when missing: **${stats.avgMissedDrift}%**`,
                        inline: false,
                    });

                    const embed = new EmbedBuilder()
                        .setTitle('🔍 Post-Exit Analysis')
                        .setColor(stats.missedRunners > stats.goodExits ? 0xffaa00 : 0x00ff88)
                        .addFields(fields)
                        .setFooter({ text: 'Checks run at +4h · +24h · +72h · +7d after every close' });

                    await msg.channel.send({ embeds: [embed] });
                    break;
                }

                case '!performance':
                case '!perf': {
                    const pt = require('./performanceTracker');
                    const s  = pt.getSummary();
                    if (s.note) { await msg.reply(`📈 ${s.note} (${s.points} snapshot${s.points === 1 ? '' : 's'} so far — hourly). Check back in a few hours.`); break; }

                    const fmt = (series, label) => {
                        if (!series) return `${label}: —`;
                        const arrow = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v}%`;
                        return `**${label}**: $${series.current}  ·  all-time ${arrow(series.changeAll)}  ·  24h ${arrow(series.change24h)}  ·  maxDD ${series.maxDrawdown}%`;
                    };

                    const embed = new EmbedBuilder()
                        .setTitle('📈 Performance — All Markets')
                        .setColor((s.combined?.changeAll ?? 0) >= 0 ? 0x00ff88 : 0xff4444)
                        .setDescription(`Tracking since ${new Date(s.since).toLocaleDateString()} · ${s.points} hourly snapshots`)
                        .addFields(
                            { name: '💰 Combined', value: fmt(s.combined, 'All markets'), inline: false },
                            { name: '🇺🇸 Alpaca (US)', value: fmt(s.alpacaEquity, 'Stocks/crypto/options/risky'), inline: false },
                            { name: '🌏 Asian Paper', value: fmt(s.asianValue, 'AU/JP/CN/UK'), inline: false },
                            { name: '🪙 MEXC Paper', value: fmt(s.mexcValue, 'Alt/meme/defi'), inline: false },
                        )
                        .setFooter({ text: 'maxDD = max drawdown (worst peak-to-trough drop)' });
                    await msg.channel.send({ embeds: [embed] });
                    break;
                }

                case '!scan':
                    await msg.reply(`Last scan: **${data?.lastScan || 'not yet'}** · Scans run every 5 min`);
                    break;
            }
        } catch (err) {
            console.log('[Discord] Command error:', err.message);
        }
    });

    client.login(process.env.DISCORD_BOT_TOKEN).catch(err =>
        console.log('[Discord] Login failed:', err.message)
    );
}

module.exports = { init, sendToChannel, reportEmbeds };
