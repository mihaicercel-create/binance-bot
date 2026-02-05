const ccxt = require('ccxt');
const http = require('http');

const config = {
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  leverage: parseInt(process.env.LEVERAGE || '5'),
  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '0.05'),
  interval: parseInt(process.env.CHECK_INTERVAL || '5')
};

let exchange;
let trailing = {};
let BASE = 'USDC';


// ================= INDICATORS =================

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = [values[0]];

  for (let i = 1; i < values.length; i++)
    result.push(values[i] * k + result[i - 1] * (1 - k));

  return result;
}

function rsi(values, period = 14) {
  let gains = 0, losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signal = ema(macdLine, 9);

  return {
    macd: macdLine.at(-1),
    signal: signal.at(-1)
  };
}


// ================= SIGNAL =================

async function getSignal(symbol) {

  const candles = await exchange.fetchOHLCV(symbol, '15m', undefined, 100);
  const closes = candles.map(c => c[4]);

  const fast = ema(closes, 9).at(-1);
  const slow = ema(closes, 21).at(-1);
  const rsiVal = rsi(closes);
  const macdVal = macd(closes);

  if (fast > slow && rsiVal > 50 && macdVal.macd > macdVal.signal)
    return 'LONG';

  if (fast < slow && rsiVal < 50 && macdVal.macd < macdVal.signal)
    return 'SHORT';

  return null;
}


// ================= POSITION SIZE =================

function calcSize(balance, price) {
  const risk = balance * config.riskPerTrade;
  return (risk * config.leverage) / price;
}


// ================= TRAILING =================

function checkTrailing(symbol, pos) {

  const entry = pos.entryPrice;
  const mark = pos.markPrice;
  const side = pos.side;

  const profit =
    side === 'long'
      ? (mark - entry) / entry
      : (entry - mark) / entry;

  if (!trailing[symbol])
    trailing[symbol] = { peak: mark, active: false };

  const state = trailing[symbol];

  if (side === 'long' && mark > state.peak) state.peak = mark;
  if (side === 'short' && mark < state.peak) state.peak = mark;

  if (profit >= 0.12) state.active = true;

  if (!state.active) return false;

  const trigger =
    side === 'long'
      ? state.peak * 0.97
      : state.peak * 1.03;

  return side === 'long'
    ? mark <= trigger
    : mark >= trigger;
}


// ================= OPEN TRADE =================

async function openTrade(symbol, side, balance) {

  const ticker = await exchange.fetchTicker(symbol);
  const price = ticker.last;
  const size = calcSize(balance, price);

  console.log(`Opening ${side} ${symbol}`);

  await exchange.setLeverage(config.leverage, symbol);

  await exchange.createMarketOrder(
    symbol,
    side === 'LONG' ? 'buy' : 'sell',
    size
  );
}


// ================= MANAGE POSITIONS =================

async function managePositions() {

  const positions = await exchange.fetchPositions();

  for (const p of positions) {

    if (!p.contracts || p.contracts == 0) continue;

    if (checkTrailing(p.symbol, p)) {

      console.log(`Closing ${p.symbol} trailing`);

      await exchange.createMarketOrder(
        p.symbol,
        p.side === 'long' ? 'sell' : 'buy',
        Math.abs(p.contracts)
      );

      delete trailing[p.symbol];
    }
  }
}


// ================= TRADING LOOP =================

async function cycle() {

  const balance = await exchange.fetchBalance();
  const free = balance[BASE]?.free || 0;

  await managePositions();

  const open = (await exchange.fetchPositions())
    .filter(p => p.contracts != 0);

  if (open.length >= 3) return;

  const pairs = [
    `BTC/${BASE}`,
    `ETH/${BASE}`,
    `SOL/${BASE}`
  ];

  for (const symbol of pairs) {

    const signal = await getSignal(symbol);
    if (!signal) continue;

    await openTrade(symbol, signal, free);
  }
}


// ================= INIT =================

async function start() {

  exchange = new ccxt.binance({
    apiKey: config.apiKey,
    secret: config.apiSecret,
    enableRateLimit: true,
    options: { defaultType: 'future' }
  });

  console.log('Bot started');

  await cycle();

  setInterval(cycle, config.interval * 60000);
}


// ================= HEALTH SERVER =================

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot running');
}).listen(PORT);

start();
