const ccxt = require('ccxt');

const config = {
  apiKey: process.env.BINANCE_API_KEY || '',
  apiSecret: process.env.BINANCE_API_SECRET || '',
  leverage: parseInt(process.env.LEVERAGE || '5'),
  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '0.08'),
  checkIntervalMin: parseInt(process.env.CHECK_INTERVAL || '5')
};

let exchange;
let isRunning = false;
let BASE_CURRENCY = 'USDC';

async function initialize() {
  try {
    console.log('🚀 Initializing Binance Futures Trading Bot...');
    console.log(`⚙️  Leverage: ${config.leverage}x`);
    console.log(`⚙️  Risk per trade: ${(config.riskPerTrade * 100).toFixed(0)}%`);
    console.log(`💵 Base Currency: ${BASE_CURRENCY}`);
    
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('Missing API credentials');
    }
    
    exchange = new ccxt.binance({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
        recvWindow: 60000
      }
    });

    console.log('🔌 Testing Binance Futures connection...');
    const balance = await exchange.fetchBalance();
    
    console.log('✅ Connected to Binance Futures!');
    
    const totalBalance = parseFloat(balance[BASE_CURRENCY]?.total || 0);
    const freeBalance = parseFloat(balance[BASE_CURRENCY]?.free || 0);
    const usedBalance = parseFloat(balance[BASE_CURRENCY]?.used || 0);
    
    console.log('\n' + '='.repeat(60));
    console.log('💰 FUTURES ACCOUNT STATUS');
    console.log('='.repeat(60));
    console.log(`Base Currency: ${BASE_CURRENCY}`);
    console.log(`Total Balance: $${totalBalance.toFixed(2)}`);
    console.log(`Available: $${freeBalance.toFixed(2)}`);
    console.log(`In Positions: $${usedBalance.toFixed(2)}`);
    console.log('='.repeat(60) + '\n');
    
    if (totalBalance < 50) {
      console.log('⚠️  Balance too low. Need at least $50 to trade.');
      return false;
    }
    
    const openPositions = await exchange.fetchPositions();
    const activePositions = openPositions.filter(p => parseFloat(p.contracts || 0) !== 0);
    
    if (activePositions.length > 0) {
      console.log(`📊 Open Positions: ${activePositions.length}`);
      activePositions.forEach(pos => {
        const side = parseFloat(pos.contracts) > 0 ? 'LONG' : 'SHORT';
        const pnl = parseFloat(pos.unrealizedPnl || 0);
        const pnlEmoji = pnl >= 0 ? '💚' : '❤️';
        console.log(`  ${pnlEmoji} ${pos.symbol} ${side} | PnL: $${pnl.toFixed(2)}`);
      });
      console.log('');
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Initialization failed:', error.message);
    if (error.message.includes('restricted')) {
      console.error('🚫 IP or permissions issue.');
    }
    return false;
  }
}

async function getMarketSignal(symbol) {
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 20);
    
    if (!ohlcv || ohlcv.length < 10) return null;
    
    const closes = ohlcv.map(c => c[4]);
    const volumes = ohlcv.map(c => c[5]);
    
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const change = ((currentPrice - prevPrice) / prevPrice) * 100;
    
    const recentCloses = closes.slice(-5);
    const avgRecent = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    
    const olderCloses = closes.slice(-10, -5);
    const avgOlder = olderCloses.reduce((a, b) => a + b, 0) / olderCloses.length;
    
    const momentum = ((avgRecent - avgOlder) / avgOlder) * 100;
    
    const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const currentVolume = volumes[volumes.length - 1];
    const volumeSurge = currentVolume > avgVolume * 1.5;
    
    return {
      price: currentPrice,
      change,
      momentum,
      volumeSurge,
      signal: momentum > 0.5 && volumeSurge ? 'LONG' : momentum < -0.5 && volumeSurge ? 'SHORT' : 'NEUTRAL'
    };
    
  } catch (error) {
    console.error(`Error analyzing ${symbol}:`, error.message);
    return null;
  }
}

async function executeTradingCycle() {
  try {
    console.log(`\n[${new Date().toISOString()}] 🔄 Trading Cycle\n`);
    
    const balance = await exchange.fetchBalance();
    const freeBalance = parseFloat(balance[BASE_CURRENCY]?.free || 0);
    
    console.log(`💵 Available: $${freeBalance.toFixed(2)} ${BASE_CURRENCY}`);
    
    const openPositions = await exchange.fetchPositions();
    const activePositions = openPositions.filter(p => parseFloat(p.contracts || 0) !== 0);
    
    if (activePositions.length > 0) {
      console.log(`\n📊 Managing ${activePositions.length} open position(s):`);
      for (const pos of activePositions) {
        const contracts = parseFloat(pos.contracts || 0);
        const side = contracts > 0 ? 'LONG' : 'SHORT';
        const entryPrice = parseFloat(pos.entryPrice || 0);
        const markPrice = parseFloat(pos.markPrice || 0);
        const pnl = parseFloat(pos.unrealizedPnl || 0);
        const pnlPercent = parseFloat(pos.percentage || 0);
        
        const emoji = pnl >= 0 ? '💚' : '❤️';
        console.log(`  ${emoji} ${pos.symbol} ${side} @ $${entryPrice.toFixed(2)} | Mark: $${markPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
        
        const lossThreshold = -config.riskPerTrade;
        if (pnlPercent < lossThreshold * 100) {
          console.log(`  ⚠️  Stop-loss triggered! Closing ${pos.symbol}...`);
        }
        
        if (pnlPercent > 15) {
          console.log(`  🎯 Take profit triggered! Closing ${pos.symbol}...`);
        }
      }
    }
    
    const watchlist = [
      `BTC/${BASE_CURRENCY}`,
      `ETH/${BASE_CURRENCY}`,
      `BNB/${BASE_CURRENCY}`,
      `SOL/${BASE_CURRENCY}`
    ];
    
    console.log(`\n📈 Market Analysis:`);
    
    for (const symbol of watchlist) {
      try {
        const signal = await getMarketSignal(symbol);
        if (!signal) continue;
        
        const emoji = signal.change >= 0 ? '📈' : '📉';
        const signalEmoji = signal.signal === 'LONG' ? '🟢' : signal.signal === 'SHORT' ? '🔴' : '⚪';
        
        console.log(`  ${emoji} ${symbol}: $${signal.price.toFixed(2)} (${signal.change >= 0 ? '+' : ''}${signal.change.toFixed(2)}%) ${signalEmoji} ${signal.signal}`);
        
        if (signal.signal !== 'NEUTRAL' && activePositions.length < 3 && freeBalance > 100) {
          console.log(`    💡 Opportunity: ${signal.signal} signal (momentum: ${signal.momentum.toFixed(2)}%)`);
        }
        
      } catch (e) {
        console.log(`  ⚠️  ${symbol}: Not available`);
      }
    }
    
    console.log(`\n⏸️  Monitoring mode (live trading coming soon)`);
    
  } catch (error) {
    console.error('❌ Error in trading cycle:', error.message);
  }
}

async function run() {
  const initialized = await initialize();
  
  if (!initialized) {
    console.log('\n⏸️  Bot paused. Retrying in 5 minutes...');
    setTimeout(run, 5 * 60 * 1000);
    return;
  }
  
  isRunning = true;
  console.log('✅ Futures Bot is LIVE!\n');
  console.log(`⏰ Check interval: every ${config.checkIntervalMin} minutes\n`);
  
  await executeTradingCycle();
  
  setInterval(async () => {
    if (isRunning) {
      await executeTradingCycle();
    }
  }, config.checkIntervalMin * 60 * 1000);
}

const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      running: isRunning,
      type: 'futures',
      leverage: config.leverage,
      baseCurrency: BASE_CURRENCY,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Binance Futures Trading Bot
Running: ${isRunning}
Leverage: ${config.leverage}x
Base: ${BASE_CURRENCY}
`);
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  run().catch(console.error);
});
