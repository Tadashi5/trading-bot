require('dotenv').config();
const axios = require('axios');

const YF_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
};

const AU_STOCKS = [
    { symbol: 'BHP.AX',  name: 'BHP'          },
    { symbol: 'CBA.AX',  name: 'CommBank'     },
    { symbol: 'CSL.AX',  name: 'CSL'          },
    { symbol: 'NAB.AX',  name: 'NAB'          },
    { symbol: 'ANZ.AX',  name: 'ANZ'          },
    { symbol: 'WBC.AX',  name: 'Westpac'      },
    { symbol: 'MQG.AX',  name: 'Macquarie'    },
    { symbol: 'RIO.AX',  name: 'Rio Tinto'    },
    { symbol: 'WES.AX',  name: 'Wesfarmers'   },
    { symbol: 'TLS.AX',  name: 'Telstra'      },
    { symbol: 'FMG.AX',  name: 'Fortescue'    },
    { symbol: 'WDS.AX',  name: 'Woodside'     },
    { symbol: 'ALL.AX',  name: 'Aristocrat'   },
    { symbol: 'REA.AX',  name: 'REA Group'    },
    { symbol: 'XRO.AX',  name: 'Xero'         },
    { symbol: 'WOW.AX',  name: 'Woolworths'   },
    { symbol: 'TCL.AX',  name: 'Transurban'   },
    { symbol: 'GMG.AX',  name: 'Goodman Grp'  },
    { symbol: 'SQ2.AX',  name: 'Block (SQ)'   },
    { symbol: 'ZIP.AX',  name: 'Zip Co'       },
];

const JP_STOCKS = [
    { symbol: '7203.T',  name: 'Toyota'           },
    { symbol: '6758.T',  name: 'Sony'             },
    { symbol: '9984.T',  name: 'SoftBank'         },
    { symbol: '8306.T',  name: 'MUFG'             },
    { symbol: '9432.T',  name: 'NTT'              },
    { symbol: '6861.T',  name: 'Keyence'          },
    { symbol: '7974.T',  name: 'Nintendo'         },
    { symbol: '9983.T',  name: 'Fast Retailing'   },
    { symbol: '6501.T',  name: 'Hitachi'          },
    { symbol: '6367.T',  name: 'Daikin'           },
    { symbol: '6902.T',  name: 'Denso'            },
    { symbol: '8035.T',  name: 'Tokyo Electron'   },
    { symbol: '6954.T',  name: 'Fanuc'            },
    { symbol: '4063.T',  name: 'Shin-Etsu'        },
    { symbol: '6594.T',  name: 'Nidec'            },
    { symbol: '7741.T',  name: 'HOYA'             },
    { symbol: '4519.T',  name: 'Chugai Pharma'    },
    { symbol: '6098.T',  name: 'Recruit'          },
    { symbol: '9433.T',  name: 'KDDI'             },
    { symbol: '6723.T',  name: 'Renesas'          },
];

const CN_STOCKS = [
    { symbol: '0700.HK', name: 'Tencent'        },
    { symbol: '9988.HK', name: 'Alibaba'        },
    { symbol: '0941.HK', name: 'China Mobile'   },
    { symbol: '3690.HK', name: 'Meituan'        },
    { symbol: '9618.HK', name: 'JD.com'         },
    { symbol: '1810.HK', name: 'Xiaomi'         },
    { symbol: '2318.HK', name: 'Ping An'        },
    { symbol: '9999.HK', name: 'NetEase'        },
    { symbol: '1299.HK', name: 'AIA Group'      },
    { symbol: '0005.HK', name: 'HSBC'           },
    { symbol: '9888.HK', name: 'Baidu'          },
    { symbol: '2020.HK', name: 'Anta Sports'    },
    { symbol: '0981.HK', name: 'SMIC'           },
    { symbol: '1211.HK', name: 'BYD'            },
    { symbol: '2269.HK', name: 'WuXi Bio'       },
    { symbol: '0388.HK', name: 'HKEX'           },
    { symbol: '0175.HK', name: 'Geely'          },
    { symbol: '3988.HK', name: 'Bank of China'  },
    { symbol: '0883.HK', name: 'CNOOC'          },
    { symbol: '1024.HK', name: 'Kuaishou'       },
];

const UK_STOCKS = [
    { symbol: 'SHEL.L',  name: 'Shell'           },
    { symbol: 'AZN.L',   name: 'AstraZeneca'     },
    { symbol: 'HSBA.L',  name: 'HSBC'            },
    { symbol: 'ULVR.L',  name: 'Unilever'        },
    { symbol: 'BP.L',    name: 'BP'              },
    { symbol: 'GSK.L',   name: 'GSK'             },
    { symbol: 'RIO.L',   name: 'Rio Tinto'       },
    { symbol: 'LSEG.L',  name: 'LSE Group'       },
    { symbol: 'DGE.L',   name: 'Diageo'          },
    { symbol: 'BATS.L',  name: 'BAT'             },
    { symbol: 'REL.L',   name: 'RELX'            },
    { symbol: 'AAL.L',   name: 'Anglo American'  },
    { symbol: 'LLOY.L',  name: 'Lloyds Bank'     },
    { symbol: 'BARC.L',  name: 'Barclays'        },
    { symbol: 'VOD.L',   name: 'Vodafone'        },
    { symbol: 'NG.L',    name: 'National Grid'   },
    { symbol: 'ARM.L',   name: 'ARM Holdings'    },
    { symbol: 'RR.L',    name: 'Rolls-Royce'     },
    { symbol: 'BA.L',    name: 'BAE Systems'     },
    { symbol: 'GLEN.L',  name: 'Glencore'        },
];

const BULLISH = ['surge','rally','gain','rise','buy','bullish','soar','high','positive','record','growth','strong'];
const BEARISH = ['crash','drop','loss','fall','sell','bearish','plunge','negative','weak','slump','recession','concern'];

// ── Yahoo Finance (v8 chart endpoint — works from cloud) ─────────────────────

async function fetchSingleQuote(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
            { headers: YF_HEADERS, timeout: 10000 }
        );
        const meta = res.data?.chart?.result?.[0]?.meta;
        const closes = res.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        if (!meta) return null;
        const price = meta.regularMarketPrice;
        const prevClose = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose;
        const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        return { price, change, currency: meta.currency || '', name: symbol };
    } catch { return null; }
}

async function fetchBatchQuotes(symbols) {
    // Try FMP batch first (fast, reliable from cloud)
    const fmpKey = process.env.FMP_API_KEY;
    if (fmpKey) {
        try {
            // FMP uses different symbols: .AX → .AX, .T → .T, .HK → .HK, .L → .L — same format
            // But indexes: ^AXJO → ^AXJO not supported, use individual fetches for those
            const stockSymbols = symbols.filter(s => !s.startsWith('^'));
            const indexSymbols = symbols.filter(s => s.startsWith('^'));

            const map = {};

            // Batch stock quotes via FMP (max 50 per call)
            for (let i = 0; i < stockSymbols.length; i += 50) {
                const batch = stockSymbols.slice(i, i + 50).join(',');
                const res = await axios.get(
                    `https://financialmodelingprep.com/api/v3/quote/${batch}?apikey=${fmpKey}`,
                    { timeout: 12000 }
                );
                for (const q of (res.data || [])) {
                    map[q.symbol] = {
                        price: q.price,
                        change: q.changesPercentage ?? 0,
                        currency: q.currency || '',
                        name: q.name || q.symbol,
                    };
                }
            }

            // Index quotes via FMP
            const fmpIndexMap = { '^AXJO': '^AXJO', '^N225': '^N225', '^HSI': '^HSI', '^FTSE': '^FTSE', '^DJI': '^DJI', '^VIX': '^VIX' };
            if (indexSymbols.length) {
                const idxBatch = indexSymbols.join(',');
                try {
                    const res = await axios.get(
                        `https://financialmodelingprep.com/api/v3/quote/${idxBatch}?apikey=${fmpKey}`,
                        { timeout: 12000 }
                    );
                    for (const q of (res.data || [])) {
                        map[q.symbol] = {
                            price: q.price,
                            change: q.changesPercentage ?? 0,
                            currency: q.currency || '',
                            name: q.name || q.symbol,
                        };
                    }
                } catch {}
            }

            if (Object.keys(map).length > 5) return map;
        } catch {}
    }

    // Fallback: Yahoo v8 chart endpoint (individual calls, slower but reliable)
    const map = {};
    const chunks = [];
    for (let i = 0; i < symbols.length; i += 5) {
        chunks.push(symbols.slice(i, i + 5));
    }
    for (const chunk of chunks) {
        const results = await Promise.all(chunk.map(s => fetchSingleQuote(s)));
        chunk.forEach((sym, idx) => { if (results[idx]) map[sym] = results[idx]; });
    }
    return map;
}

async function fetch30DayReturns(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=35d`,
            { headers: YF_HEADERS, timeout: 12000 }
        );
        const closes = res.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        const returns = [];
        for (let i = 1; i < closes.length; i++) {
            if (closes[i] != null && closes[i - 1] != null && closes[i - 1] !== 0)
                returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
        }
        return returns;
    } catch { return []; }
}

// ── Correlation ───────────────────────────────────────────────────────────────

function pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 5) return null;
    const a = x.slice(-n), b = y.slice(-n);
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da2 = 0, db2 = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - ma, db = b[i] - mb;
        num += da * db; da2 += da * da; db2 += db * db;
    }
    const denom = Math.sqrt(da2 * db2);
    return denom === 0 ? null : parseFloat((num / denom).toFixed(3));
}

function corrLabel(r) {
    if (r === null) return 'N/A';
    if (r > 0.7)  return 'Strong +';
    if (r > 0.4)  return 'Moderate +';
    if (r > 0.1)  return 'Weak +';
    if (r < -0.7) return 'Strong −';
    if (r < -0.4) return 'Moderate −';
    if (r < -0.1) return 'Weak −';
    return 'Uncorrelated';
}

function corrInterpret(r, marketName) {
    if (r === null) return 'Insufficient data for correlation analysis.';
    const abs = Math.abs(r);
    const dir = r >= 0 ? 'same direction as' : 'opposite direction to';
    const str = abs > 0.7 ? 'strongly' : abs > 0.4 ? 'moderately' : abs > 0.1 ? 'weakly' : 'not meaningfully';
    return `${marketName} ${str} tracks ${dir} US markets (SPY) over the past 30 days.`;
}

// ── News / Sentiment ──────────────────────────────────────────────────────────

async function getNews(query) {
    // Try NewsAPI first
    try {
        const res = await axios.get(
            `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&apiKey=${process.env.NEWS_API_KEY}`,
            { timeout: 8000 }
        );
        if (res.data.articles?.length) return res.data.articles;
    } catch {}

    // Fallback: Google News RSS
    try {
        const res = await axios.get(
            `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const titles = (res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || []).slice(0, 5);
        return titles.map(t => ({ title: t.replace(/<title><!\[CDATA\[|\]\]><\/title>/g, ''), description: '' }));
    } catch {}

    return [];
}

function sentimentScore(articles) {
    let score = 0;
    for (const a of articles) {
        const t = `${a.title} ${a.description || ''}`.toLowerCase();
        BULLISH.forEach(w => { if (t.includes(w)) score++; });
        BEARISH.forEach(w => { if (t.includes(w)) score--; });
    }
    return score;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan() {
    const allSymbols = [
        ...AU_STOCKS.map(s => s.symbol),
        ...JP_STOCKS.map(s => s.symbol),
        ...CN_STOCKS.map(s => s.symbol),
        ...UK_STOCKS.map(s => s.symbol),
        '^AXJO', '^N225', '^HSI', '^FTSE',
        'SPY', 'QQQ', '^DJI', '^VIX',
    ];

    // Fetch everything in parallel
    const [quotes, [auNews, jpNews, cnNews, ukNews], [spyR, axjoR, n225R, hsiR, ftseR]] = await Promise.all([
        fetchBatchQuotes(allSymbols),
        Promise.all([
            getNews('ASX Australian stock market'),
            getNews('Nikkei Japan stock market'),
            getNews('Hang Seng Hong Kong China stocks'),
            getNews('FTSE London stock market UK'),
        ]),
        Promise.all([
            fetch30DayReturns('SPY'),
            fetch30DayReturns('^AXJO'),
            fetch30DayReturns('^N225'),
            fetch30DayReturns('^HSI'),
            fetch30DayReturns('^FTSE'),
        ]),
    ]);

    function buildMarket(indexSym, indexName, stocks, news, returns, flag, marketName) {
        const indexQ   = quotes[indexSym];
        const score    = sentimentScore(news);
        const corr     = pearson(returns, spyR);
        const spyToday = spyR.length ? parseFloat(spyR[spyR.length - 1].toFixed(2)) : 0;

        return {
            flag,
            market: marketName,
            index: {
                symbol: indexSym,
                name:   indexName,
                price:  indexQ?.price  ?? null,
                change: indexQ ? parseFloat(indexQ.change.toFixed(2)) : null,
            },
            newsScore: score,
            headlines: news.slice(0, 3).map(a => a.title),
            stocks: stocks.map(s => {
                const q = quotes[s.symbol];
                if (!q) return null;
                return {
                    symbol:   s.symbol,
                    name:     s.name,
                    price:    q.price,
                    change:   parseFloat(q.change.toFixed(2)),
                    currency: q.currency,
                    signal:   q.change > 2 ? 'BULLISH' : q.change < -2 ? 'BEARISH' : 'NEUTRAL',
                };
            }).filter(Boolean),
            correlation: {
                spy:       corr,
                label:     corrLabel(corr),
                interpret: corrInterpret(corr, marketName),
                spyToday,
                indexToday: indexQ ? parseFloat(indexQ.change.toFixed(2)) : null,
            },
        };
    }

    const q = (sym, decimals = 2) => {
        const d = quotes[sym];
        return d ? { price: d.price, change: parseFloat(d.change.toFixed(decimals)) } : null;
    };

    return {
        au: buildMarket('^AXJO', 'ASX 200',     AU_STOCKS, auNews, axjoR, '🇦🇺', 'Australia'),
        jp: buildMarket('^N225', 'Nikkei 225',  JP_STOCKS, jpNews, n225R, '🇯🇵', 'Japan'),
        cn: buildMarket('^HSI',  'Hang Seng',   CN_STOCKS, cnNews, hsiR,  '🇭🇰', 'China / HK'),
        uk: buildMarket('^FTSE', 'FTSE 100',    UK_STOCKS, ukNews, ftseR, '🇬🇧', 'United Kingdom'),
        us: {
            spy: q('SPY'),
            qqq: q('QQQ'),
            dji: q('^DJI'),
            vix: q('^VIX', 1),
        },
        scannedAt: new Date().toLocaleTimeString(),
    };
}

module.exports = { scan };
