'use strict';
/**
 * Central Telegram routing bot.
 * Long-polls Telegram and routes each user's messages to their dedicated
 * Fargate container. Provisions containers on first contact.
 */
const https = require('https');
const http = require('http');
const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { provisionUser, getContainerIp } = require('../infra/provision-user');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'claudecode-users';
const OFFSET_FILE = `${process.env.HOME || '/home/ubuntu'}/.claudecode-router-offset`;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const dynamo = new DynamoDBClient({ region: AWS_REGION });
const fs = require('fs');

// ── Telegram helpers ──────────────────────────────────────────────────────
function tgRequest(method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await tgRequest('sendMessage', { chat_id: chatId, text: chunk });
  }
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────
async function getUser(chatId) {
  const { Item } = await dynamo.send(new GetItemCommand({
    TableName: DYNAMO_TABLE,
    Key: { chatId: { S: String(chatId) } },
  }));
  if (!Item) return null;
  return {
    chatId: Item.chatId?.S,
    status: Item.status?.S,
    privateIp: Item.privateIp?.S,
    taskArn: Item.taskArn?.S,
    efsAccessPointId: Item.efsAccessPointId?.S,
  };
}

async function putUser(chatId, attrs) {
  const item = { chatId: { S: String(chatId) } };
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) item[k] = { S: String(v) };
  }
  await dynamo.send(new PutItemCommand({ TableName: DYNAMO_TABLE, Item: item }));
}

// ── Bridge HTTP helper ────────────────────────────────────────────────────
function bridgePost(ip, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: ip,
      port: 3000,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 130000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('bridge timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function bridgeGet(ip, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname: ip, port: 3000, path, method: 'GET', timeout: 10000 };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Wait for container to register its IP ─────────────────────────────────
async function waitForContainer(chatId, maxWaitMs = 120000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const user = await getUser(chatId);
    if (user?.status === 'running' && user.privateIp) return user.privateIp;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Container did not come online in time');
}

// ── Handle a single incoming message ─────────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const username = msg.from?.username || msg.from?.first_name || 'user';

  if (text === '/start') {
    await sendMessage(chatId,
      `Welcome, ${username}! 👋\n\nI'm setting up your personal Claude Code environment. This takes about 60 seconds.\n\nYou'll need to authenticate with your Anthropic account — I'll send you a link shortly.`
    );
  }

  let user = await getUser(chatId);

  // New user — provision a container
  if (!user || user.status === 'stopped' || user.status === 'error') {
    await sendMessage(chatId, '⚙️ Spinning up your container...');
    await putUser(chatId, { status: 'provisioning', username, createdAt: new Date().toISOString() });
    try {
      const { taskArn, efsAccessPointId } = await provisionUser(chatId);
      await putUser(chatId, { status: 'provisioning', taskArn, efsAccessPointId });
      await sendMessage(chatId, '🔄 Container started — waiting for it to come online...');
    } catch (e) {
      console.error('Provision failed:', e);
      await sendMessage(chatId, `❌ Failed to provision your environment: ${e.message}\nTry again with /start`);
      await putUser(chatId, { status: 'error' });
      return;
    }
    user = await getUser(chatId);
  }

  // Wait for container if still provisioning
  if (user.status === 'provisioning' || !user.privateIp) {
    await sendMessage(chatId, '⏳ Still starting up, please wait...');
    try {
      const ip = await waitForContainer(chatId);
      user = { ...user, privateIp: ip, status: 'running' };
    } catch (e) {
      await sendMessage(chatId, '❌ Container failed to start. Try /start to retry.');
      await putUser(chatId, { status: 'error' });
      return;
    }
  }

  // Check auth status first time
  let authStatus;
  try {
    authStatus = await bridgeGet(user.privateIp, '/auth-status');
  } catch (e) {
    await sendMessage(chatId, '❌ Could not reach your container. Try /start to restart.');
    await putUser(chatId, { status: 'error' });
    return;
  }

  if (authStatus.error) {
    await sendMessage(chatId, `❌ Container error: ${authStatus.error}\nTry /start to restart.`);
    await putUser(chatId, { status: 'error' });
    return;
  }

  if (!authStatus.authenticated) {
    if (!authStatus.authUrl) {
      await sendMessage(chatId, '❌ Could not get auth URL. Try /start to restart.');
      return;
    }
    await sendMessage(chatId,
      `🔐 Authenticate with your Anthropic account:\n\n${authStatus.authUrl}\n\nOpen this link, sign in, then send me any message to continue.`
    );
    return;
  }

  // Forward message to Claude Code
  if (!text || text === '/start') return;

  try {
    const result = await bridgePost(user.privateIp, '/chat', { message: text });
    if (result.needsAuth) {
      await sendMessage(chatId, `🔐 Session expired. Re-authenticate:\n\n${result.authUrl}`);
      return;
    }
    if (result.error) {
      await sendMessage(chatId, `⚠️ ${result.error}`);
      return;
    }
    await sendMessage(chatId, result.response || '(no response)');
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${e.message}`);
  }
}

// ── Long-poll loop ────────────────────────────────────────────────────────
function loadOffset() {
  try { return Number(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function saveOffset(n) {
  fs.writeFileSync(OFFSET_FILE, String(n));
}

async function poll() {
  let offset = loadOffset();
  console.log('Router bot started, polling...');
  while (true) {
    try {
      const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      if (!res.ok || !res.result?.length) continue;
      for (const update of res.result) {
        offset = update.update_id + 1;
        saveOffset(offset);
        if (update.message) {
          handleMessage(update.message).catch((e) => console.error('handleMessage error:', e));
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

poll();
