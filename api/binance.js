import crypto from 'crypto';

function firmar(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_KEY = process.env.BINANCE_API_KEY;
  const SECRET_KEY = process.env.BINANCE_SECRET_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const BASE = 'https://testnet.binance.vision';

  try {
    const { action, symbol = 'BTCUSDT' } = req.method === 'GET' ? req.query : req.body;

    // ============================================================
    // TEST - Ping simple (no necesita firma)
    // ============================================================
    if (action === 'test') {
      if (!API_KEY || !SECRET_KEY) {
        return res.json({ success: false, error: 'API keys de Binance no configuradas en Vercel' });
      }

      const testResponse = await fetch(`${BASE}/api/v3/ping`, {
        headers: { 'X-MBX-APIKEY': API_KEY }
      });

      if (!testResponse.ok) {
        const bodyText = await testResponse.text().catch(() => '');
        return res.json({
          success: false,
          message: '❌ Error de conexión',
          debug_status: testResponse.status,
          debug_body: bodyText
        });
      }

      return res.json({ success: true, message: '✅ Conectado a Binance Testnet' });
    }

    // ============================================================
    // PRICE - Público, no necesita firma
    // ============================================================
    if (action === 'price') {
      const priceResponse = await fetch(`${BASE}/api/v3/ticker/price?symbol=${symbol}`);

      if (!priceResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo precio' });
      }

      const priceData = await priceResponse.json();
      return res.json({ success: true, price: priceData.price });
    }

    // ============================================================
    // BALANCE - Privado, necesita firma
    // ============================================================
    if (action === 'balance') {
      if (!API_KEY || !SECRET_KEY) {
        return res.status(400).json({ error: 'Binance keys no configuradas' });
      }

      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = firmar(query, SECRET_KEY);

      const balanceResponse = await fetch(
        `${BASE}/api/v3/account?${query}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': API_KEY } }
      );

      if (!balanceResponse.ok) {
        const errData = await balanceResponse.json().catch(() => ({}));
        return res.status(500).json({ error: errData.msg || 'Error obteniendo saldo' });
      }

      const balanceData = await balanceResponse.json();
      const usdtBalance = balanceData.balances?.find(b => b.asset === 'USDT');

      return res.json({ success: true, balance: usdtBalance?.free || 0 });
    }

    // ============================================================
    // ORDER - Privado, necesita firma
    // ============================================================
    if (action === 'order') {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Método no permitido' });
      }

      if (!API_KEY || !SECRET_KEY) {
        return res.status(400).json({ success: false, error: 'Binance keys no configuradas' });
      }

      const { side, quantity } = req.body;

      if (!side || !quantity) {
        return res.status(400).json({ success: false, error: 'Faltan side o quantity' });
      }

      const timestamp = Date.now();
      const query = `symbol=BTCUSDT&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
      const signature = firmar(query, SECRET_KEY);

      const orderResponse = await fetch(
        `${BASE}/api/v3/order?${query}&signature=${signature}`,
        { method: 'POST', headers: { 'X-MBX-APIKEY': API_KEY } }
      );

      const orderData = await orderResponse.json();

      if (orderResponse.ok) {
        return res.json({ success: true, order: orderData });
      } else {
        return res.json({ success: false, error: orderData.msg || 'Orden falló' });
      }
    }

    // ============================================================
    // CHAT - Groq
    // ============================================================
    if (action === 'chat') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
      }

      if (!GROQ_KEY) {
        return res.status(400).json({ error: 'Groq API key no configurada en Vercel', fallback: true });
      }

      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'Mensaje vacío' });
      }

      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'llama3-8b-8192',
            messages: [
              { role: 'system', content: 'Eres un asistente de trading profesional. Respondes en español de forma clara y estructurada, con datos útiles para el usuario.' },
              { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 500
          })
        });

        const data = await groqRes.json();

        if (data.choices && data.choices[0]) {
          return res.json({ success: true, response: data.choices[0].message.content });
        } else {
          return res.json({ success: false, error: 'Error con Groq', fallback: true });
        }
      } catch (error) {
        return res.json({ success: false, error: error.message, fallback: true });
      }
    }

    return res.status(400).json({ success: false, error: 'Acción no válida. Usa: test, price, balance, order, chat' });

  } catch (error) {
    console.error('Error en API:', error);
    return res.status(500).json({ success: false, error: error.message || 'Error interno del servidor' });
  }
}
