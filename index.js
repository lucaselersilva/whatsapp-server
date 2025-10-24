// index.js
// ---------------------------
// Servidor WhatsApp + API + Persistência de sessão (Supabase)
// ---------------------------

import express from 'express';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// =========================
// Config & Globals
// =========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Faltam variáveis de ambiente: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Caminho da pasta de auth local (LocalAuth usa .wwebjs_auth/<clientId>)
const AUTH_ROOT = path.join(__dirname, '.wwebjs_auth');
const CLIENT_ID = 'default'; // ajuste se quiser múltiplas sessões
const AUTH_DIR = path.join(AUTH_ROOT, `session-${CLIENT_ID}`);

// Flags simples de status
let isReady = false;
let currentQR = null;

// =========================
// Util: Persistência da sessão no Supabase
// Serializa TODOS os arquivos da pasta .wwebjs_auth/session-<id> em JSON (base64).
// Na inicialização, reconstroi a árvore de arquivos local a partir do Supabase.
// =========================
async function readDirRecursive(dir) {
  const result = {};
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(AUTH_ROOT, full); // caminho relativo à raiz .wwebjs_auth

      if (ent.isDirectory()) {
        // Descemos, mas não gravamos diretório — apenas arquivos
        const child = await readDirRecursive(full);
        Object.assign(result, child);
      } else if (ent.isFile()) {
        const buf = await fsp.readFile(full);
        result[rel] = buf.toString('base64');
      }
    }
  } catch (e) {
    // Se a pasta ainda não existe, tudo bem
  }
  return result;
}

async function writeFilesFromMap(fileMap) {
  if (!fileMap || typeof fileMap !== 'object') return;

  for (const relPath of Object.keys(fileMap)) {
    const absPath = path.join(AUTH_ROOT, relPath);
    const dir = path.dirname(absPath);
    await fsp.mkdir(dir, { recursive: true });
    const content = Buffer.from(fileMap[relPath], 'base64');
    await fsp.writeFile(absPath, content);
  }
}

async function loadSessionFolderFromDB() {
  try {
    const { data, error } = await supabase
      .from('whatsapp_auth')
      .select('folder')
      .eq('id', 1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('⚠️ Erro ao carregar sessão do Supabase:', error);
      return;
    }

    if (data?.folder) {
      await writeFilesFromMap(data.folder);
      console.log('📦 Sessão restaurada do Supabase para', AUTH_DIR);
    } else {
      console.log('ℹ️ Nenhuma sessão salva no Supabase (primeiro login esperado).');
    }
  } catch (e) {
    console.error('⚠️ Falha ao restaurar sessão:', e);
  }
}

async function saveSessionFolderToDB() {
  try {
    // Lê toda a pasta .wwebjs_auth e serializa arquivos
    const fileMap = await readDirRecursive(AUTH_ROOT);
    if (!Object.keys(fileMap).length) {
      console.log('ℹ️ Nenhum arquivo de sessão encontrado para salvar ainda.');
      return;
    }

    const { error } = await supabase
      .from('whatsapp_auth')
      .upsert({ id: 1, folder: fileMap });

    if (error) {
      console.error('⚠️ Erro ao salvar sessão no Supabase:', error);
    } else {
      console.log('💾 Sessão salva no Supabase (', Object.keys(fileMap).length, 'arquivos )');
    }
  } catch (e) {
    console.error('⚠️ Falha ao salvar sessão:', e);
  }
}

// =========================
// Inicialização: garante pastas e carrega sessão
// =========================
await fsp.mkdir(AUTH_DIR, { recursive: true });
await loadSessionFolderFromDB();

// =========================
// WhatsApp Client
// =========================
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_ROOT,
    clientId: CLIENT_ID
  }),
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

// QR gerado
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

// Autenticado
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

  // Salva snapshot da sessão no Supabase
  await saveSessionFolderToDB();
});

// Pronto
client.on('ready', async () => {
  console.log('🚀 Cliente WhatsApp pronto!');
  isReady = true;

  await supabase
    .from('whatsapp_sessions')
    .update({ status: 'ready' })
    .eq('id', 1);

  // Garante que a última sessão está persistida
  await saveSessionFolderToDB();
});

// Desconectado
client.on('disconnected', async (reason) => {
  console.log('❌ Cliente desconectado:', reason);
  isReady = false;

  await supabase
    .from('whatsapp_sessions')
    .update({ status: 'disconnected' })
    .eq('id', 1);

  // Salva o que houver antes de sair (se existir algo)
  await saveSessionFolderToDB();
});

// Mensagens
client.on('message', async (msg) => {
  try {
    console.log(`📨 Mensagem de ${msg.from}: ${msg.body}`);
    const phone = msg.from.replace('@c.us', '');

    // Busca um tenant (ajuste: vincule por número do próprio bot, se precisar multi-tenant real)
    const { data: tenant, error: tenErr } = await supabase
      .from('tenants')
      .select('id, business_name')
      .limit(1)
      .single();

    if (tenErr || !tenant) {
      console.error('❌ Nenhum tenant encontrado:', tenErr);
      return;
    }

    // Busca/cria cliente
    let { data: clientData, error: cErr } = await supabase
      .from('clients')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('phone', `+${phone}`)
      .maybeSingle();

    if (!clientData) {
      const { data: newClient, error: insErr } = await supabase
        .from('clients')
        .insert({
          tenant_id: tenant.id,
          phone: `+${phone}`,
          name: msg._data?.notifyName || null
        })
        .select()
        .single();

      if (insErr) {
        console.error('❌ Erro criando cliente:', insErr);
        return;
      }
      clientData = newClient;
    }

    // Log da mensagem
    await supabase
      .from('messages')
      .insert({
        tenant_id: tenant.id,
        client_id: clientData.id,
        body: msg.body,
        direction: 'inbound'
      });

    // Chama sua função Edge/Function
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

    if (chatData?.response) {
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
  } catch (e) {
    console.error('⚠️ Erro ao processar mensagem:', e);
  }
});

// =========================
// API HTTP
// =========================
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
    console.error('⚠️ Falha ao enviar mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Boot
// =========================
app.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});

// Inicializa o cliente
client.initialize();

// Salva sessão ao encerrar (melhor esforço)
const shutdown = async (signal) => {
  console.log(`🔻 Recebido ${signal}, salvando sessão e encerrando...`);
  try {
    await saveSessionFolderToDB();
  } catch (_) {}
  process.exit(0);
};

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));
