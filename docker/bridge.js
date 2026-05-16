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
const CRED_FILE = path.join(CLAUDE_HOME, '.claude', 'credentials.json');
const SESSION_FILE = path.join(CLAUDE_HOME, 'session.json');

fs.mkdirSync(path.join(CLAUDE_HOME, '.claude'), { recursive: true });

const dynamo = new DynamoDBClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });

const app = express();
app.use(express.json());

let authProc = null;
let authUrl = null;
let sessionId = null;

// ── S3 helpers ────────────────────────────────────────────────────────────
const s3CredKey = `sessions/${USER_CHAT_ID}/credentials.json`;

async function loadCredsFromS3() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3CredKey }));
    const body = await res.Body.transformToString();
    fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
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
  try {
    if (!fs.existsSync(CRED_FILE)) return false;
    const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    return !!(creds?.oauth?.access_token || creds?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

function startAuthFlow() {
  return new Promise((resolve, reject) => {
    if (authUrl) return resolve(authUrl);
    if (authProc) return reject(new Error('Auth already in progress'));

    authProc = spawn('claude', ['auth', 'login'], {
      env: { ...process.env, HOME: CLAUDE_HOME },
    });

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/claude\.ai\/[^\s]+/);
      if (match && !authUrl) {
        authUrl = match[0];
        resolve(authUrl);
      }
    };
    authProc.stdout.on('data', onData);
    authProc.stderr.on('data', onData);
    authProc.on('close', (code) => {
      authProc = null;
      if (code === 0) {
        authUrl = null;
        saveCredsToS3();
        console.log('Auth completed, saved to S3');
      }
    });

    setTimeout(() => {
      if (!authUrl) {
        authProc?.kill();
        authProc = null;
        reject(new Error('Auth URL not received within 20s'));
      }
    }, 20000);
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
    const proc = spawn('claude', args, {
      env: { ...process.env, HOME: CLAUDE_HOME },
      timeout: 120000,
    });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
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
  try {
    const url = await startAuthFlow();
    res.json({ authenticated: false, authUrl: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
