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
  const GROQ_KEY = process.env.GROQ_API_KEY;

  try {
    const { action, symbol = 'BTCUSDT' } = req.method === 'GET' ? req.query : req.body;

    // ============================================================
    // ACCIÓN: TEST - Probar conexión a Binance
    // ============================================================
    if (action === 'test') {
      if (!API_KEY || !SECRET_KEY) {
        return res.json({ 
          success: false, 
          error: 'API keys de Binance no configuradas en Vercel' 
        });
      }

      const testResponse = await fetch(
        `https://testnet.binance.vision/api/v3/ping`,
        { headers: { 'X-MBX-APIKEY': API_KEY } }
      );
      
      return res.json({ 
        success: testResponse.ok,
        message: testResponse.ok ? '✅ Conectado a Binance Testnet' : '❌ Error de conexión'
      });
    }

    // ============================================================
    // ACCIÓN: PRICE - Obtener precio de un activo
    // ============================================================
    if (action === 'price') {
      if (!API_KEY || !SECRET_KEY) {
        return res.status(400).json({ error: 'Binance keys no configuradas' });
      }

      const priceResponse = await fetch(
        `https://testnet.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
        { headers: { 'X-MBX-APIKEY': API_KEY } }
      );
      
      if (!priceResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo precio' });
      }
      
      const priceData = await priceResponse.json();
      return res.json({ 
        success: true, 
        price: priceData.price 
      });
    }

    // ============================================================
    // ACCIÓN: BALANCE - Obtener saldo de USDT
    // ============================================================
    if (action === 'balance') {
      if (!API_KEY || !SECRET_KEY) {
        return res.status(400).json({ error: 'Binance keys no configuradas' });
      }

      const timestamp = Date.now();
      const balanceResponse = await fetch(
        `https://testnet.binance.vision/api/v3/account?timestamp=${timestamp}`,
        { headers: { 'X-MBX-APIKEY': API_KEY } }
      );
      
      if (!balanceResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo saldo' });
      }
      
      const balanceData = await balanceResponse.json();
      const usdtBalance = balanceData.balances?.find(b => b.asset === 'USDT');
      
      return res.json({ 
        success: true, 
        balance: usdtBalance?.free || 0 
      });
    }

    // ============================================================
    // ACCIÓN: ORDER - Ejecutar orden en Testnet
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

      const orderTimestamp = Date.now();
      const orderResponse = await fetch(
        `https://testnet.binance.vision/api/v3/order?symbol=BTCUSDT&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${orderTimestamp}`,
        { 
          method: 'POST',
          headers: { 'X-MBX-APIKEY': API_KEY }
        }
      );
      
      const orderData = await orderResponse.json();
      
      if (orderResponse.ok) {
        return res.json({ success: true, order: orderData });
      } else {
        return res.json({ success: false, error: orderData.msg || 'Orden falló' });
      }
    }

    // ============================================================
    // ACCIÓN: CHAT - Usar Groq para responder preguntas
    // ============================================================
    if (action === 'chat') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
      }

      if (!GROQ_KEY) {
        return res.status(400).json({ 
          error: 'Groq API key no configurada en Vercel',
          fallback: true 
        });
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
              { 
                role: 'system', 
                content: 'Eres un asistente de trading profesional. Respondes en español de forma clara y estructurada, con datos útiles para el usuario.' 
              },
              { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 500
          })
        });

        const data = await groqRes.json();
        
        if (data.choices && data.choices[0]) {
          return res.json({ 
            success: true, 
            response: data.choices[0].message.content 
          });
        } else {
          return res.json({ 
            success: false, 
            error: 'Error con Groq',
            fallback: true
          });
        }
      } catch (error) {
        return res.json({ 
          success: false, 
          error: error.message,
          fallback: true
        });
      }
    }

    // ============================================================
    // ACCIÓN NO VÁLIDA
    // ============================================================
    return res.status(400).json({ 
      success: false, 
      error: 'Acción no válida. Usa: test, price, balance, order, chat' 
    });

  } catch (error) {
    console.error('Error en API:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Error interno del servidor' 
    });
  }
          }
