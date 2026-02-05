const ccxt = require('ccxt');
const http = require('http');

const CONFIG = {
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  leverage: Number(process.env.LEVERAGE || 5),
  risk: Number(process.env.RISK_PER_TRADE || 0.03),
  interval: Number(process.env.CHECK_INTERVAL || 5)
};

const BASE = 'USDC';

let exchange;
let trailing = {};


// ================= INIT EXCHANGE =================

async function initExchange() {

  exchange = new ccxt.binance({
    apiKey: CONFIG.apiKey,
    secret: CONFIG.apiSecret,
    enableRateLimit: true,
    options: {
      defaultType: 'future'
    }
  });

  await exchange.loadMarkets();

  console.log("USDC Futures Markets Loaded");
}


// ================= INDICATORS =================

function ema(values, period) {
  const k = 2 / (period + 1);
  let arr = [values[0]];

  for (let i = 1; i < values.length; i++)
    arr.push(values[i] * k + arr[i - 1] * (1 - k));

  return arr;
}

function rsi(values, period = 14) {
  let gain = 0, loss = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  if (loss === 0) return 100;

  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}


// ================= SIGNAL =================

async function getSignal(symbol) {

  const candles = await exchange.fetchOHLCV(symbol, '15m', undefined, 100);
  const closes = candles.map(c => c[4]);

  const fast = ema(closes, 9).at(-1);
  const slow = ema(closes, 21).at(-1);
  const rsiVal = rsi(closes);

  if (fast > slow && rsiVal > 50) return 'LONG';
  if (fast < slow && rsiVal < 50) return 'SHORT';

  return null;
}


// ================= POSITION SIZE =================

function calcSize(balance, price) {
  const riskCapital = balance * CONFIG.risk;
  return (riskCapital * CONFIG.leverage) / price;
}


// ================= TRAILING =================

function trailingStop(symbol, pos) {

  const entry = pos.entryPrice;
  const mark = pos.markPrice;
  const side = pos.side;

  const profit =
    side === 'long'
      ? (mark - entry) / entry
      : (entry - mark) / entry;

  if (!trailing[symbol])
    trailing[symbol] = { peak: mark, active: false };

  let state = trailing[symbol];

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

  console.log(`OPEN ${side} ${symbol}`);

  await exchange.setLeverage(CONFIG.leverage, symbol);

  await exchange.createMarketOrder(
    symbol,
    side === 'LONG' ? 'buy' : 'sell',
    size
  );
}


// ================= MANAGE POSITIONS =================

async function managePositions() {

  const positions = await exchange.fetchPositions();

  for (const pos of positions) {

    if (!pos.contracts || pos.contracts == 0) continue;

    if (trailingStop(pos.symbol, pos)) {

      console.log(`Trailing close ${pos.symbol}`);

      await exchange.createMarketOrder(
        pos.symbol,
        pos.side === 'long' ? 'sell' : 'buy',
        Math.abs(pos.contracts)
      );

      delete trailing[pos.symbol];
    }
  }
}


// ================= MAIN LOOP =================

async function cycle() {

  const balanceData = await exchange.fetchBalance();
  const balance = balanceData.total[BASE];

  await managePositions();

  const openPositions = (await exchange.fetchPositions())
    .filter(p => p.contracts != 0);

  if (openPositions.length >= 3) return;

  const pairs = [
    'BTC/USDC:USDC',
    'ETH/USDC:USDC',
    'SOL/USDC:USDC'
  ];

  for (const symbol of pairs) {

    const signal = await getSignal(symbol);
    if (!signal) continue;

    await openTrade(symbol, signal, balance);
  }
}


// ================= START =================

async function start() {

  await initExchange();

  console.log("USDC Futures Bot Started");

  await cycle();
  setInterval(cycle, CONFIG.interval * 60000);
}


// ================= HEALTH SERVER =================

const PORT = process.env.PORT || 3000;

http.createServer((req,res)=>{
  res.writeHead(200);
  res.end('USDC Futures Bot Running');
}).listen(PORT);

start();
