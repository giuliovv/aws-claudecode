'use strict';
/**
 * Central Telegram routing bot.
 * Long-polls Telegram and routes each user's messages to their dedicated
 * Fargate container. Provisions containers on first contact.
 */
const https = require('https');
const http = require('http');
const { DynamoDBClient, GetItemCommand, UpdateItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { ECSClient, StopTaskCommand, ListTasksCommand } = require('@aws-sdk/client-ecs');
const { provisionUser, getContainerIp } = require('../infra/provision-user');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'claudecode-users';
const OFFSET_FILE = `${process.env.HOME || '/home/ubuntu'}/.claudecode-router-offset`;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const DAILY_MSG_LIMIT = Number(process.env.DAILY_MSG_LIMIT || '50');

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const ECS_CLUSTER = process.env.ECS_CLUSTER || 'claudecode';

const dynamo = new DynamoDBClient({ region: AWS_REGION });
const ecs = new ECSClient({ region: AWS_REGION });
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

async function sendMessageWithId(chatId, text) {
  const res = await tgRequest('sendMessage', { chat_id: chatId, text });
  return res?.result?.message_id;
}

async function editMessage(chatId, messageId, text) {
  return tgRequest('editMessageText', { chat_id: chatId, message_id: messageId, text });
}

async function deleteMessage(chatId, messageId) {
  return tgRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
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
    allowed: Item.allowed?.S === 'true',
    msgCount: Number(Item.msgCount?.N || 0),
    msgDate: Item.msgDate?.S || '',
  };
}

async function putUser(chatId, attrs) {
  const parts = [];
  const names = {};
  const values = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    const nk = `#f_${k}`;
    const vk = `:v_${k}`;
    parts.push(`${nk} = ${vk}`);
    names[nk] = k;
    values[vk] = { S: String(v) };
  }
  if (!parts.length) return;
  await dynamo.send(new UpdateItemCommand({
    TableName: DYNAMO_TABLE,
    Key: { chatId: { S: String(chatId) } },
    UpdateExpression: `SET ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ── Container restart ─────────────────────────────────────────────────────
async function restartUser(targetId) {
  const user = await getUser(targetId);
  if (user?.taskArn) {
    try {
      await ecs.send(new StopTaskCommand({ cluster: ECS_CLUSTER, task: user.taskArn, reason: 'admin restart' }));
    } catch (e) {
      console.error(`StopTask failed for ${targetId}:`, e.message);
    }
  }
  await putUser(targetId, { status: 'stopped', privateIp: '', taskArn: '' });
}

// ── Access control ────────────────────────────────────────────────────────
function isAdmin(chatId) {
  return ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID);
}

async function setUserAllowed(chatId, allowed) {
  await dynamo.send(new UpdateItemCommand({
    TableName: DYNAMO_TABLE,
    Key: { chatId: { S: String(chatId) } },
    UpdateExpression: 'SET allowed = :a',
    ExpressionAttributeValues: { ':a': { S: allowed ? 'true' : 'false' } },
  }));
}

// Returns true if under limit, false if capped. Increments count atomically.
async function checkUsage(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const user = await getUser(chatId);
  const resetCount = user?.msgDate !== today;
  const currentCount = resetCount ? 0 : (user?.msgCount || 0);
  if (currentCount >= DAILY_MSG_LIMIT) return false;
  await dynamo.send(new UpdateItemCommand({
    TableName: DYNAMO_TABLE,
    Key: { chatId: { S: String(chatId) } },
    UpdateExpression: 'SET msgCount = :c, msgDate = :d',
    ExpressionAttributeValues: {
      ':c': { N: String(currentCount + 1) },
      ':d': { S: today },
    },
  }));
  return true;
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
      timeout: 620000,
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

function bridgeGet(ip, path, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const options = { hostname: ip, port: 3000, path, method: 'GET', timeout: timeoutMs };
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

  // ── Admin commands ──────────────────────────────────────────────────────
  if (isAdmin(chatId)) {
    const approveMatch = text.match(/^\/approve\s+(\d+)$/);
    const blockMatch = text.match(/^\/block\s+(\d+)$/);
    const restartMatch = text.match(/^\/restart\s+(\d+)$/);
    const restartAllCmd = text === '/restart-all';
    const usersCmd = text === '/users';

    if (approveMatch) {
      const targetId = approveMatch[1];
      await setUserAllowed(targetId, true);
      await sendMessage(chatId, `✅ User ${targetId} approved.`);
      await sendMessage(targetId, '✅ You have been approved! Send /start to begin.').catch(() => {});
      return;
    }
    if (blockMatch) {
      const targetId = blockMatch[1];
      await setUserAllowed(targetId, false);
      await sendMessage(chatId, `🚫 User ${targetId} blocked.`);
      return;
    }
    if (restartMatch) {
      const targetId = restartMatch[1];
      await sendMessage(chatId, `🔄 Restarting container for ${targetId}...`);
      await restartUser(targetId);
      await sendMessage(chatId, `✅ Done. ${targetId} will get a fresh container on next message.`);
      return;
    }
    if (restartAllCmd) {
      const { Items } = await dynamo.send(new ScanCommand({
        TableName: DYNAMO_TABLE,
        ProjectionExpression: 'chatId, #st',
        ExpressionAttributeNames: { '#st': 'status' },
        FilterExpression: '#st = :r',
        ExpressionAttributeValues: { ':r': { S: 'running' } },
      }));
      const running = (Items || []).map(i => i.chatId?.S).filter(Boolean);
      if (!running.length) { await sendMessage(chatId, 'No running containers.'); return; }
      await sendMessage(chatId, `🔄 Restarting ${running.length} container(s)...`);
      await Promise.all(running.map(id => restartUser(id)));
      await sendMessage(chatId, `✅ Done. All ${running.length} user(s) will get fresh containers on next message.`);
      return;
    }
    if (usersCmd) {
      const { Items } = await dynamo.send(new ScanCommand({
        TableName: DYNAMO_TABLE,
        ProjectionExpression: 'chatId, #st, allowed, msgCount, msgDate, username',
        ExpressionAttributeNames: { '#st': 'status' },
      }));
      const lines = (Items || []).map(i =>
        `${i.chatId?.S} @${i.username?.S || '?'} status=${i.status?.S} allowed=${i.allowed?.S || 'false'} msgs=${i.msgCount?.N || 0}/${i.msgDate?.S || '-'}`
      );
      await sendMessage(chatId, lines.length ? lines.join('\n') : 'No users yet.');
      return;
    }
  }

  // ── Allowlist check ─────────────────────────────────────────────────────
  if (!isAdmin(chatId)) {
    let user = await getUser(chatId);
    if (!user?.allowed) {
      // Notify admin once per first contact (no record yet)
      if (!user && ADMIN_CHAT_ID) {
        await sendMessage(ADMIN_CHAT_ID,
          `🔔 New user wants access:\nID: ${chatId}\nUsername: @${username}\n\nReply /approve ${chatId} to grant access.`
        ).catch(() => {});
      }
      await sendMessage(chatId, '⛔ This bot is invite-only. Your request has been forwarded to the admin.');
      // Create a pending record so admin can see them in /users
      if (!user) await putUser(chatId, { status: 'pending', username, allowed: 'false' });
      return;
    }
  }

  if (text === '/start') {
    await sendMessage(chatId,
      `Welcome, ${username}! 👋\n\nI'm setting up your personal Claude Code environment. This takes about 60 seconds.\n\nYou'll need to authenticate with your Anthropic account — I'll send you a link shortly.`
    );
  }

  let user = await getUser(chatId);

  // New user — provision a container
  if (!user || user.status === 'stopped' || user.status === 'error' || user.status === 'pending') {
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
    if (authStatus.pendingCompletion) {
      await sendMessage(chatId, '⏳ Authentication completing, please wait a moment then send another message.');
      return;
    }
    if (authStatus.waitingForCode && text && text !== '/start') {
      // User is pasting the auth code back
      try {
        await bridgePost(user.privateIp, '/auth-code', { code: text });
        await sendMessage(chatId, '✅ Code submitted! Send me a message in a few seconds to start chatting.');
      } catch (e) {
        await sendMessage(chatId, `❌ Failed to submit code: ${e.message}`);
      }
      return;
    }
    await sendMessage(chatId,
      `🔐 Authenticate with your Anthropic account:\n\n${authStatus.authUrl}\n\nSign in, then paste the code you receive back here.`
    );
    return;
  }

  // Forward message to Claude Code
  if (!text || text === '/start') return;

  if (!isAdmin(chatId)) {
    const underLimit = await checkUsage(chatId);
    if (!underLimit) {
      await sendMessage(chatId, `⛔ Daily message limit (${DAILY_MSG_LIMIT}) reached. Try again tomorrow.`);
      return;
    }
  }

  // Show working indicator while Claude processes
  tgRequest('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const workingMsgId = await sendMessageWithId(chatId, '⏳ Working...').catch(() => null);
  const startedAt = Date.now();
  let tickCount = 0;
  const typingInterval = setInterval(() => {
    tgRequest('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    tickCount++;
    if (workingMsgId && tickCount % 5 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      editMessage(chatId, workingMsgId, `⏳ Working... (${elapsed}s)`).catch(() => {});
    }
  }, 4000);

  try {
    const result = await bridgePost(user.privateIp, '/chat', { message: text });
    clearInterval(typingInterval);

    if (result.needsAuth) {
      if (workingMsgId) await deleteMessage(chatId, workingMsgId).catch(() => {});
      await sendMessage(chatId, `🔐 Session expired. Re-authenticate:\n\n${result.authUrl}`);
      return;
    }
    if (result.error) {
      const errText = `⚠️ ${result.error}`;
      if (workingMsgId) await editMessage(chatId, workingMsgId, errText).catch(() => sendMessage(chatId, errText));
      else await sendMessage(chatId, errText);
      return;
    }

    const response = result.response || '(no response)';
    if (workingMsgId) {
      if (response.length <= 4000) {
        await editMessage(chatId, workingMsgId, response).catch(() => sendMessage(chatId, response));
      } else {
        await deleteMessage(chatId, workingMsgId).catch(() => {});
        await sendMessage(chatId, response);
      }
    } else {
      await sendMessage(chatId, response);
    }
  } catch (e) {
    clearInterval(typingInterval);
    const errText = `❌ Error: ${e.message}`;
    if (workingMsgId) await editMessage(chatId, workingMsgId, errText).catch(() => sendMessage(chatId, errText));
    else await sendMessage(chatId, errText);
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
