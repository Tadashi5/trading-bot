require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');

const HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

const COINS = [
    { id: 'bitcoin',  symbol: 'BTC/USD',  name: 'Bitcoin'  },
    { id: 'ethereum', symbol: 'ETH/USD',  name: 'Ethereum' },
    { id: 'solana',   symbol: 'SOL/USD',  name: 'Solana'   },
    { id: 'dogecoin', symbol: 'DOGE/USD', name: 'Dogecoin' },
];

const BULLISH = ['surge','rally','bull','gain','rise','moon','pump','breakout','adoption'];
const BEARISH = ['crash','drop','bear','loss','fall','dump','ban','hack','fraud','liquidat'];

async function getAccount() {
    const res = await axios.get(`${BASE}/account`, { headers: HEADERS });
    return res.data;
}

async function getPrices() {
    const ids = COINS.map(c => c.id).join(',');
    const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    return res.data;
}

async function getNews(query) {
    const res = await axios.get(`https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=10&apiKey=${process.env.NEWS_API_KEY}`);
    return res.data.articles;
}

function sentiment(articles) {
    let score = 0;
    articles.forEach(a => {
        const text = `${a.title} ${a.description || ''}`.toLowerCase();
        BULLISH.forEach(w => { if (text.includes(w)) score++; });
        BEARISH.forEach(w => { if (text.includes(w)) score--; });
    });
    return score;
}

async function placeOrder(symbol, side, qty) {
    try {
        await axios.post(`${BASE}/orders`, {
            symbol, qty, side, type: 'market', time_in_force: 'gtc'
        }, { headers: HEADERS });
        console.log(`  ✓ ${side.toUpperCase()} ${qty} ${symbol}`);
    } catch (err) {
        console.log(`  ✗ Order failed: ${err.response?.data?.message || err.message}`);
    }
}

async function run() {
    console.log(`\n========== ${new Date().toLocaleTimeString()} ==========`);

    const account = await getAccount();
    const cash = parseFloat(account.cash);
    console.log(`Cash: $${cash.toFixed(2)}`);

    const prices = await getPrices();
    const posRes = await axios.get(`${BASE}/positions`, { headers: HEADERS });
    const positions = posRes.data;
    const held = positions.map(p => p.symbol);

    for (const coin of COINS) {
        const data = prices[coin.id];
        if (!data) continue;

        const price = data.usd;
        const change = data.usd_24h_change;
        const news = await getNews(coin.name);
        const score = sentiment(news);
        const hasPosition = held.includes(coin.symbol);

        console.log(`\n${coin.name}: $${price} | 24h: ${change.toFixed(2)}% | Sentiment: ${score}`);

        if (change > 3 && score > 0 && !hasPosition && cash > 100) {
            const qty = ((cash * 0.1) / price).toFixed(6);
            console.log(`  → BUY signal`);
            await placeOrder(coin.symbol, 'buy', qty);

        } else if (change < -3 && score < 0 && hasPosition) {
            const pos = positions.find(p => p.symbol === coin.symbol);
            console.log(`  → SELL signal`);
            await placeOrder(coin.symbol, 'sell', pos.qty);

        } else {
            console.log(`  → No signal`);
        }
    }
}

run();
cron.schedule('*/5 * * * *', run);
console.log('Bot started. Scanning every 5 minutes. Press Ctrl+C to stop.');