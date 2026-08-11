export default async function handler(req, res) {
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Obtener variables de entorno (seguras en Vercel)
  const API_KEY = process.env.BINANCE_API_KEY;
  const SECRET_KEY = process.env.BINANCE_SECRET_KEY;

  if (!API_KEY || !SECRET_KEY) {
    return res.status(400).json({ 
      success: false, 
      error: 'API keys not configured in Vercel environment variables' 
    });
  }

  try {
    const { action, symbol = 'BTCUSDT' } = req.method === 'GET' ? req.query : req.body;

    // Acciones disponibles
    switch (action) {
      case 'test':
        // Probar conexión
        const testResponse = await fetch(
          `https://testnet.binance.vision/api/v3/ping`,
          { headers: { 'X-MBX-APIKEY': API_KEY } }
        );
        return res.json({ 
          success: testResponse.ok,
          message: testResponse.ok ? 'Connected to Binance Testnet' : 'Connection failed'
        });

      case 'price':
        // Obtener precio
        const priceResponse = await fetch(
          `https://testnet.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
          { headers: { 'X-MBX-APIKEY': API_KEY } }
        );
        const priceData = await priceResponse.json();
        return res.json({ 
          success: true, 
          price: priceData.price 
        });

      case 'balance':
        // Obtener balance
        const timestamp = Date.now();
        const balanceResponse = await fetch(
          `https://testnet.binance.vision/api/v3/account?timestamp=${timestamp}`,
          { headers: { 'X-MBX-APIKEY': API_KEY } }
        );
        const balanceData = await balanceResponse.json();
        const usdtBalance = balanceData.balances?.find(b => b.asset === 'USDT');
        return res.json({ 
          success: true, 
          balance: usdtBalance?.free || 0 
        });

      case 'order':
        // Ejecutar orden (solo en testnet)
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const { side, quantity } = req.body;
        const orderTimestamp = Date.now();
        const orderResponse = await fetch(
          `https://testnet.binance.vision/api/v3/order?symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${orderTimestamp}`,
          { 
            method: 'POST',
            headers: { 'X-MBX-APIKEY': API_KEY }
          }
        );
        const orderData = await orderResponse.json();
        
        if (orderResponse.ok) {
          return res.json({ success: true, order: orderData });
        } else {
          return res.json({ success: false, error: orderData.msg || 'Order failed' });
        }

      default:
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid action. Use: test, price, balance, order' 
        });
    }
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  }
}