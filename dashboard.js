require('dotenv').config();
const blessed = require('blessed');
const crypto = require('./crypto');
const options = require('./options');
const axios = require('axios');

const HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

const screen = blessed.screen({ smartCSR: true, title: 'Trading Bot Dashboard' });

const header = blessed.box({
    top: 0, left: 0, width: '100%', height: 3,
    content: ' TRADING BOT DASHBOARD',
    style: { fg: 'green', bold: true, bg: 'black' },
    border: { type: 'line', fg: 'green' }
});

const accountBox = blessed.box({
    top: 3, left: 0, width: '50%', height: 6,
    label: ' Account ',
    border: { type: 'line', fg: 'cyan' },
    style: { fg: 'white' }
});

const fearGreedBox = blessed.box({
    top: 3, left: '50%', width: '50%', height: 6,
    label: ' Market Mood ',
    border: { type: 'line', fg: 'yellow' },
    style: { fg: 'white' }
});

const cryptoBox = blessed.box({
    top: 9, left: 0, width: '50%', height: '40%',
    label: ' Crypto Scanner ',
    border: { type: 'line', fg: 'green' },
    style: { fg: 'white' },
    scrollable: true
});

const optionsBox = blessed.box({
    top: 9, left: '50%', width: '50%', height: '40%',
    label: ' Options Scanner ',
    border: { type: 'line', fg: 'magenta' },
    style: { fg: 'white' },
    scrollable: true
});

const logBox = blessed.box({
    bottom: 0, left: 0, width: '100%', height: '25%',
    label: ' Trade Log ',
    border: { type: 'line', fg: 'red' },
    style: { fg: 'white' },
    scrollable: true,
    alwaysScroll: true
});

screen.append(header);
screen.append(accountBox);
screen.append(fearGreedBox);
screen.append(cryptoBox);
screen.append(optionsBox);
screen.append(logBox);

screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

const logs = [];
function log(msg) {
    const time = new Date().toLocaleTimeString();
    logs.push(`[${time}] ${msg}`);
    logBox.setContent(logs.slice(-20).join('\n'));
    screen.render();
}

async function update() {
    try {
        log('Scanning crypto...');
        const { results: cryptoResults, cash } = await crypto.scan();

        const accountRes = await axios.get(`${BASE}/account`, { headers: HEADERS });
        const acc = accountRes.data;
        accountBox.setContent(
            ` Cash:       $${parseFloat(acc.cash).toFixed(2)}\n` +
            ` Portfolio:  $${parseFloat(acc.portfolio_value).toFixed(2)}\n` +
            ` P&L:        $${parseFloat(acc.equity - acc.last_equity).toFixed(2)}`
        );

        const fearRes = await axios.get('https://api.alternative.me/fng/?limit=1');
        const fg = fearRes.data.data[0];
        fearGreedBox.setContent(
            ` Index: ${fg.value} - ${fg.value_classification}\n` +
            ` ${parseInt(fg.value) < 30 ? 'EXTREME FEAR - possible buy opportunity' : ''}\n` +
            ` ${parseInt(fg.value) > 70 ? 'EXTREME GREED - be cautious' : ''}`
        );

        let cryptoContent = '';
        cryptoResults.forEach(r => {
            const color = r.signal === 'BUY' ? '{green-fg}' : r.signal === 'SELL' ? '{red-fg}' : '{white-fg}';
            cryptoContent += `${color}${r.name.padEnd(10)}{/} $${r.price} | ${r.change}% | Sentiment: ${r.sentiment} | ${r.signal}\n`;
            if (r.action?.success) log(`✓ ${r.signal} ${r.symbol}`);
            if (r.action?.error) log(`✗ ${r.symbol}: ${r.action.error}`);
        });
        cryptoBox.setContent(cryptoContent);

        log('Scanning options...');
        const optResults = await options.scan();

        let optContent = '';
        optResults.forEach(r => {
            const color = r.signal.includes('CALL') ? '{green-fg}' : r.signal.includes('PUT') ? '{red-fg}' : '{white-fg}';
            optContent += `${color}${r.ticker.padEnd(6)}{/} Sentiment: ${r.sentiment} | ${r.signal}\n`;
            if (r.headlines[0]) optContent += `  → ${r.headlines[0].substring(0, 60)}...\n`;
            if (r.action?.success) log(`✓ ${r.signal} ${r.contract}`);
            if (r.action?.error) log(`✗ ${r.ticker} options: ${r.action.error}`);
        });
        optionsBox.setContent(optContent);

        screen.render();
        log('Scan complete. Next scan in 5 minutes.');
    } catch (err) {
        log(`Error: ${err.message}`);
    }
}

log('Dashboard starting...');
update();
setInterval(update, 5 * 60 * 1000);