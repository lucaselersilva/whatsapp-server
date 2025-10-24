import { Client, LocalAuth } from 'whatsapp-web.js';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());

// Variáveis de ambiente
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

let isReady = false;
let currentQR = null;

client.on('qr', async (qr) => {
  console.log('🔲 QR Code gerado!');
  currentQR = qr;

  await supabase
    .from('whatsapp_sessions')
    .upsert({
      id: 1,
      qr_code: qr,
      status: 'waiting_scan',
      updated_at: new Date().toISOString()
    });
});

client.on('authenticated', async () => {
  console.log('✅ WhatsApp autenticado!');
  currentQR = null;

  await supabase
    .from('whatsapp_sessions')
    .upsert({
      id: 1,
      qr_code: null,
      status: 'connected',
      updated_at: new Date().toISOString()
    });
});

client.on('ready', async () => {
  console.log('🚀 Cliente WhatsApp pronto!');
  isReady = true;

  await supabase
    .from('whatsapp_sessions')
    .update({ status: 'ready' })
    .eq('id', 1);
});

client.on('message', async (msg) => {
  console.log(`📨 Mensagem de ${msg.from}: ${msg.body}`);

  const phone = msg.from.replace('@c.us', '');

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, business_name')
    .limit(1)
    .single();

  if (!tenant) {
    console.error('❌ Nenhum tenant encontrado');
    return;
  }

  let { data: clientData } = await supabase
    .from('clients')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('phone', `+${phone}`)
    .maybeSingle();

  if (!clientData) {
    const { data: newClient } = await supabase
      .from('clients')
      .insert({
        tenant_id: tenant.id,
        phone: `+${phone}`,
        name: msg._data?.notifyName || null
      })
      .select()
      .single();

    clientData = newClient;
  }

  await supabase
    .from('messages')
    .insert({
      tenant_id: tenant.id,
      client_id: clientData.id,
      body: msg.body,
      direction: 'inbound'
    });

  const chatResponse = await fetch(`${SUPABASE_URL}/functions/v1/chat-assistant`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientData.id,
      message: msg.body,
      tenant_id: tenant.id
    })
  });

  const chatData = await chatResponse.json();

  if (chatData.response) {
    await client.sendMessage(msg.from, chatData.response);

    await supabase
      .from('messages')
      .insert({
        tenant_id: tenant.id,
        client_id: clientData.id,
        body: chatData.response,
        direction: 'outbound'
      });
  }
});

client.on('disconnected', async (reason) => {
  console.log('❌ Cliente desconectado:', reason);
  isReady = false;

  await supabase
    .from('whatsapp_sessions')
    .update({ status: 'disconnected' })
    .eq('id', 1);
});

// API
app.get('/status', (req, res) => {
  res.json({
    ready: isReady,
    qr: currentQR,
    timestamp: new Date().toISOString()
  });
});

app.post('/send-message', async (req, res) => {
  const { to, message } = req.body;

  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp não conectado' });
  }

  try {
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    await client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});

client.initialize();
