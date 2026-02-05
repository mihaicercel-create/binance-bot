const ccxt = require('ccxt');

// Config from environment variables
const config = {
  apiKey: process.env.BINANCE_API_KEY || '',
  apiSecret: process.env.BINANCE_API_SECRET || ''
};

let exchange;
let isRunning = false;

async function initialize() {
  try {
    console.log('🚀 Initializing Binance Trading Bot...');
    
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('Missing API credentials in environment variables');
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

    console.log('🔌 Testing Binance connection...');
    const balance = await exchange.fetchBalance();
    
    console.log('✅ Connected successfully!');
    
    const currencies = Object.keys(balance.total).filter(c => balance.total[c] > 0);
    
    if (currencies.length === 0) {
      console.log('⚠️  No funds in Spot wallet. Waiting for user to unstake...');
      return false;
    }
    
    let totalUSDT = 0;
    console.log('\n💰 Account Balance:');
    
    for (const currency of currencies) {
      const amount = balance.total[currency];
      console.log(`  ${currency}: ${amount}`);
      
      if (currency === 'USDT') {
        totalUSDT += amount;
      } else {
        try {
          const ticker = await exchange.fetchTicker(`${currency}/USDT`);
          const value = amount * ticker.last;
          totalUSDT += value;
        } catch (e) {
          // Skip
        }
      }
    }
    
    console.log(`\n💵 Total Value: ~${totalUSDT.toFixed(2)} USDT\n`);
    
    if (totalUSDT < 100) {
      console.log('⚠️  Capital too low. Need at least 100 USDT.');
      return false;
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Initialization failed:', error.message);
    if (error.message.includes('restricted location')) {
      console.error('🚫 IP blocked by Binance.');
    }
    return false;
  }
}

async function executeTradingCycle() {
  try {
    console.log(`\n[${new Date().toISOString()}] Running trading cycle...`);
    
    const balance = await exchange.fetchBalance();
    const usdtBalance = balance.free.USDT || 0;
    
    console.log(`Available USDT: ${usdtBalance.toFixed(2)}`);
    
    const tickers = await exchange.fetchTickers(['BTC/USDT', 'ETH/USDT', 'BNB/USDT']);
    
    console.log('\n📊 Market Snapshot:');
    Object.entries(tickers).forEach(([symbol, ticker]) => {
      const change = ticker.percentage || 0;
      const emoji = change > 0 ? '📈' : '📉';
      console.log(`  ${emoji} ${symbol}: $${ticker.last?.toFixed(2)} (${change.toFixed(2)}%)`);
    });
    
  } catch (error) {
    console.error('Error in trading cycle:', error.message);
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
  console.log('✅ Bot is now running!\n');
  
  const intervalMinutes = 5;
  console.log(`⏰ Trading cycle: every ${intervalMinutes} minutes\n`);
  
  await executeTradingCycle();
  
  setInterval(async () => {
    if (isRunning) {
      await executeTradingCycle();
    }
  }, intervalMinutes * 60 * 1000);
}

const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      running: isRunning,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Binance Trading Bot - Running');
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  run().catch(console.error);
});
