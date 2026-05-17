'use strict';
/**
 * HTTP bridge between the central Telegram router and Claude Code CLI.
 * Runs inside each user's Fargate container.
 * Uses S3 for auth credential persistence (no EFS needed).
 */
const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const PORT = 3000;
const USER_CHAT_ID = process.env.USER_CHAT_ID || '';
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'claudecode-users';
const S3_BUCKET = process.env.S3_BUCKET || 'claudecode-sessions-854656252703';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const CLAUDE_HOME = `/tmp/claude-home-${USER_CHAT_ID}`;
const SEARCH_PATH = `/usr/local/bin:/usr/bin:/bin`;
const CLAUDE_BIN = (() => {
  const candidates = ['/usr/local/bin/claude', '/usr/bin/claude'];
  for (const p of candidates) {
    if (fs.existsSync(p)) { console.log('Found claude at', p); return p; }
  }
  try {
    const found = execSync('which claude', { env: { PATH: SEARCH_PATH }, timeout: 5000 }).toString().trim();
    if (found) { console.log('Found claude via which:', found); return found; }
  } catch {}
  try {
    const found = execSync('find /usr/local/lib/node_modules/@anthropic-ai/claude-code -name "cli.js" -maxdepth 3 2>/dev/null | head -1', { timeout: 5000 }).toString().trim();
    if (found) { console.log('Found claude cli.js at', found, '— will invoke via node'); return found; }
  } catch {}
  console.error('WARNING: claude binary not found, defaulting to /usr/local/bin/claude');
  return '/usr/local/bin/claude';
})();
const CLAUDE_IS_SCRIPT = CLAUDE_BIN.endsWith('.js');
const SPAWN_ENV = (extra = {}) => ({
  ...process.env,
  PATH: `${SEARCH_PATH}:${process.env.PATH || ''}`,
  HOME: CLAUDE_HOME,
  ...extra,
});
// Returns [bin, args] — handles both native binary and raw .js entry point
function claudeCmd(args) {
  return CLAUDE_IS_SCRIPT
    ? [process.execPath, [CLAUDE_BIN, ...args]]
    : [CLAUDE_BIN, args];
}
const CRED_FILE = path.join(CLAUDE_HOME, '.claude.json');
const SESSION_FILE = path.join(CLAUDE_HOME, 'session.json');

fs.mkdirSync(CLAUDE_HOME, { recursive: true });

const dynamo = new DynamoDBClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });

const app = express();
app.use(express.json());

let authProc = null;
let authUrl = null;
let authWaiters = [];
let codeSubmitted = false;
let isAuthedInMemory = false;
let sessionId = null;

// ── S3 helpers ────────────────────────────────────────────────────────────
const s3CredKey = `sessions/${USER_CHAT_ID}/claude.json`;

async function loadCredsFromS3() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3CredKey }));
    const body = await res.Body.transformToString();
    fs.writeFileSync(CRED_FILE, body);
    console.log('Loaded credentials from S3');
  } catch (e) {
    if (e.name !== 'NoSuchKey') console.error('S3 load failed:', e.message);
  }
}

async function saveCredsToS3() {
  if (!fs.existsSync(CRED_FILE)) return;
  try {
    const body = fs.readFileSync(CRED_FILE, 'utf8');
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3CredKey, Body: body }));
    console.log('Saved credentials to S3');
  } catch (e) {
    console.error('S3 save failed:', e.message);
  }
}

// ── Register private IP in DynamoDB ──────────────────────────────────────
async function registerSelf() {
  try {
    const ip = execSync("hostname -i | awk '{print $1}'").toString().trim();
    await dynamo.send(new UpdateItemCommand({
      TableName: DYNAMO_TABLE,
      Key: { chatId: { S: USER_CHAT_ID } },
      UpdateExpression: 'SET privateIp = :ip, #st = :st, lastSeen = :ts',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':ip': { S: ip },
        ':st': { S: 'running' },
        ':ts': { S: new Date().toISOString() },
      },
    }));
    console.log(`Registered as ${ip}`);
  } catch (e) {
    console.error('registerSelf failed:', e.message);
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────
function isAuthenticated() {
  if (isAuthedInMemory) return true;
  try {
    if (!fs.existsSync(CRED_FILE)) return false;
    const d = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    // Claude Code 2.x: ~/.claude.json with oauthAccount; older: credentials.json with oauth/claudeAiOauth
    return !!(d?.oauthAccount || d?.primaryApiKey || d?.oauth?.access_token || d?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

function startAuthFlow() {
  return new Promise((resolve, reject) => {
    if (authUrl) return resolve(authUrl);

    // Queue this caller — resolve/reject it when the URL arrives or the flow fails
    authWaiters.push({ resolve, reject });
    if (authProc) return; // already starting; just wait

    const [authBin, authArgs] = claudeCmd(['auth', 'login']);
    authProc = spawn(authBin, authArgs, { env: SPAWN_ENV() });

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/claude\.(?:ai|com)\/\S+/);
      if (match && !authUrl) {
        authUrl = match[0];
        for (const w of authWaiters.splice(0)) w.resolve(authUrl);
      }
    };
    authProc.stdout.on('data', onData);
    authProc.stderr.on('data', onData);
    authProc.on('error', (err) => {
      authProc = null;
      const e = new Error(`claude spawn failed: ${err.message}`);
      for (const w of authWaiters.splice(0)) w.reject(e);
    });
    authProc.on('close', (code) => {
      authProc = null;
      codeSubmitted = false;
      if (code === 0) {
        authUrl = null;
        isAuthedInMemory = true;
        saveCredsToS3().then(() => console.log('Auth completed, saved to S3'))
          .catch((e) => console.error('Save to S3 failed:', e.message));
      } else {
        console.error('Auth process exited with code', code, '— user may need to retry');
        authUrl = null;
      }
    });

    setTimeout(() => {
      if (!authUrl) {
        authProc?.kill();
        authProc = null;
        const e = new Error('Auth URL not received within 30s');
        for (const w of authWaiters.splice(0)) w.reject(e);
      }
    }, 30000);
  });
}

// ── Run Claude Code ───────────────────────────────────────────────────────
function runClaude(message) {
  return new Promise((resolve, reject) => {
    try {
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      sessionId = saved.sessionId;
    } catch {}

    const args = ['--print'];
    if (sessionId) args.push('--resume', sessionId);
    args.push(message);

    let stdout = '';
    let stderr = '';
    const [claudeBin, claudeArgs] = claudeCmd(args);
    const proc = spawn(claudeBin, claudeArgs, {
      env: SPAWN_ENV(),
      timeout: 120000,
    });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`claude spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        sessionId = null;
        try { fs.unlinkSync(SESSION_FILE); } catch {}
        return reject(new Error(stderr.trim() || `claude exited ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.session_id) {
          sessionId = parsed.session_id;
          fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }));
        }
        resolve(parsed.result || parsed.content || stdout.trim());
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', chatId: USER_CHAT_ID, authenticated: isAuthenticated() });
});

app.get('/auth-status', async (_req, res) => {
  if (isAuthenticated()) return res.json({ authenticated: true });
  if (codeSubmitted) return res.json({ authenticated: false, pendingCompletion: true });
  if (authUrl) return res.json({ authenticated: false, waitingForCode: true, authUrl });
  try {
    const url = await startAuthFlow();
    res.json({ authenticated: false, waitingForCode: true, authUrl: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth-code', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  if (!authProc) return res.status(400).json({ error: 'no auth in progress' });
  authProc.stdin.write(code.trim() + '\n');
  codeSubmitted = true;
  authUrl = null;
  res.json({ ok: true });
});

app.post('/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  if (!isAuthenticated()) {
    try {
      const url = await startAuthFlow();
      return res.json({ needsAuth: true, authUrl: url });
    } catch (e) {
      return res.status(500).json({ error: 'auth: ' + e.message });
    }
  }

  try {
    const response = await runClaude(message);
    res.json({ response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Bridge on :${PORT} — chatId=${USER_CHAT_ID}`);
  await loadCredsFromS3();
  await registerSelf();
});

// Save creds on clean shutdown
process.on('SIGTERM', async () => {
  await saveCredsToS3();
  process.exit(0);
});
