// tickerExtractor.js — Extract stock tickers from text
// Detects $AAPL style, bare tickers, and company name → ticker mapping

const COMPANY_MAP = {
    'apple': 'AAPL', 'microsoft': 'MSFT', 'google': 'GOOGL', 'alphabet': 'GOOGL',
    'amazon': 'AMZN', 'meta': 'META', 'facebook': 'META', 'tesla': 'TSLA',
    'nvidia': 'NVDA', 'amd': 'AMD', 'advanced micro': 'AMD',
    'netflix': 'NFLX', 'palantir': 'PLTR', 'gamestop': 'GME', 'amc': 'AMC',
    'sofi': 'SOFI', 'rivian': 'RIVN', 'arm holdings': 'ARM', 'arm': 'ARM',
    'super micro': 'SMCI', 'supermicro': 'SMCI', 'alibaba': 'BABA',
    'uber': 'UBER', 'snap': 'SNAP', 'snapchat': 'SNAP', 'roblox': 'RBLX',
    'robinhood': 'HOOD', 'ionq': 'IONQ', 'coinbase': 'COIN',
    'microstrategy': 'MSTR', 'strategy': 'MSTR',
    'bitcoin': 'BTC', 'ethereum': 'ETH', 'solana': 'SOL', 'dogecoin': 'DOGE',
    'jpmorgan': 'JPM', 'goldman sachs': 'GS', 'bank of america': 'BAC',
    'wells fargo': 'WFC', 'citigroup': 'C', 'morgan stanley': 'MS',
    'disney': 'DIS', 'boeing': 'BA', 'intel': 'INTC', 'qualcomm': 'QCOM',
    'broadcom': 'AVGO', 'salesforce': 'CRM', 'oracle': 'ORCL', 'adobe': 'ADBE',
    'paypal': 'PYPL', 'shopify': 'SHOP', 'square': 'SQ', 'block': 'SQ',
    'crowdstrike': 'CRWD', 'snowflake': 'SNOW', 'datadog': 'DDOG',
    'berkshire': 'BRK.B', 'walmart': 'WMT', 'costco': 'COST',
    'home depot': 'HD', 'target': 'TGT', 'coca-cola': 'KO', 'pepsi': 'PEP',
    'johnson & johnson': 'JNJ', 'pfizer': 'PFE', 'moderna': 'MRNA',
    'eli lilly': 'LLY', 'novo nordisk': 'NVO', 'unitedhealth': 'UNH',
    'chevron': 'CVX', 'exxon': 'XOM', 'shell': 'SHEL',
    'bhp': 'BHP', 'rio tinto': 'RIO', 'fortescue': 'FMG',
    'commonwealth bank': 'CBA.AX', 'commbank': 'CBA.AX',
    'toyota': 'TM', 'sony': 'SONY', 'softbank': '9984.T',
    'tencent': '0700.HK', 'xiaomi': '1810.HK', 'byd': '1211.HK',
    'astrazeneca': 'AZN', 'hsbc': 'HSBC', 'unilever': 'UL',
    'sp500': 'SPY', 's&p 500': 'SPY', 's&p': 'SPY', 'dow jones': 'DIA',
    'nasdaq': 'QQQ', 'russell': 'IWM', 'vix': 'VIX',
};

// Valid ticker pattern (1-5 uppercase letters, optionally with . suffix)
const TICKER_REGEX = /\$([A-Z]{1,5})\b/g;
const BARE_TICKER_REGEX = /\b([A-Z]{2,5})\b/g;

// Common words that look like tickers but aren't
const FALSE_POSITIVES = new Set([
    'CEO', 'CFO', 'CTO', 'IPO', 'ETF', 'GDP', 'CPI', 'PPI', 'FED', 'SEC',
    'NYSE', 'DOW', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'NZD', 'CHF',
    'THE', 'FOR', 'AND', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER',
    'WAS', 'ONE', 'OUR', 'OUT', 'DAY', 'GET', 'HAS', 'HIM', 'HIS', 'HOW',
    'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'BOY', 'DID', 'ITS', 'LET',
    'SAY', 'SHE', 'TOO', 'USE', 'AI', 'UK', 'US', 'EU', 'PM', 'AM',
    'API', 'RSS', 'URL', 'CEO', 'Q1', 'Q2', 'Q3', 'Q4', 'YOY', 'MOM',
    'EPS', 'PE', 'ROI', 'ROE', 'EBITDA', 'FOMC', 'PCE', 'NFP', 'PMI',
    'BPS', 'ATH', 'ATL', 'YTD', 'QTD', 'MTD', 'WTD', 'EOD', 'EOW',
    'EST', 'PST', 'GMT', 'UTC', 'IST', 'AEST', 'BST', 'HKT', 'JST',
]);

// Known valid tickers to always accept
const KNOWN_TICKERS = new Set([
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA', 'NVDA', 'AMD',
    'NFLX', 'PLTR', 'GME', 'AMC', 'SOFI', 'RIVN', 'ARM', 'SMCI', 'BABA',
    'UBER', 'SNAP', 'RBLX', 'HOOD', 'IONQ', 'COIN', 'MSTR', 'SPY', 'QQQ',
    'DIA', 'IWM', 'VIX', 'BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'ADA',
    'JPM', 'GS', 'BAC', 'WFC', 'MS', 'DIS', 'BA', 'INTC', 'QCOM', 'AVGO',
    'CRM', 'ORCL', 'ADBE', 'PYPL', 'SHOP', 'SQ', 'CRWD', 'SNOW', 'DDOG',
    'WMT', 'COST', 'HD', 'TGT', 'KO', 'PEP', 'JNJ', 'PFE', 'MRNA', 'LLY',
    'NVO', 'UNH', 'CVX', 'XOM', 'SHEL', 'BHP', 'RIO', 'TM', 'SONY',
]);

function extract(text) {
    if (!text) return [];
    const tickers = new Set();

    // 1. $TICKER mentions (highest confidence)
    let match;
    while ((match = TICKER_REGEX.exec(text)) !== null) {
        const t = match[1];
        if (!FALSE_POSITIVES.has(t)) tickers.add(t);
    }

    // 2. Company name → ticker
    const lower = text.toLowerCase();
    for (const [name, ticker] of Object.entries(COMPANY_MAP)) {
        if (lower.includes(name)) tickers.add(ticker);
    }

    // 3. Bare uppercase tickers (only if they're known valid tickers)
    while ((match = BARE_TICKER_REGEX.exec(text)) !== null) {
        const t = match[1];
        if (KNOWN_TICKERS.has(t) && !FALSE_POSITIVES.has(t)) tickers.add(t);
    }

    return [...tickers];
}

module.exports = { extract, COMPANY_MAP, KNOWN_TICKERS };
