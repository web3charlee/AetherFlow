require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const RPC_BASE = 'https://evm-rpc.test-net.interlinklabs.ai/v1';
const CHAIN_ID = 19042026n;
const DB_FILE = './schedules.json';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));

let agentWallet;
if (process.env.AGENT_PRIVATE_KEY) {
  agentWallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY);
} else {
  agentWallet = ethers.Wallet.createRandom();
  console.log('No AGENT_PRIVATE_KEY set — generated a new one for this run.');
  console.log('Address (fund this via the faucet):', agentWallet.address);
  console.log('Private key (save to the AGENT_PRIVATE_KEY env var to persist across restarts):', agentWallet.privateKey);
}

let accessToken = null, refreshToken = null, tokenExpiry = 0;
let logs = [];
function log(line) {
  logs.push({ t: Date.now(), line });
  if (logs.length > 200) logs = logs.slice(-200);
  console.log(line);
}

async function authenticate() {
  const cRes = await fetch(RPC_BASE + '/auth/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: agentWallet.address, chainId: "19042026" })
  });
  const cData = await cRes.json();
  if (!cRes.ok || cData.error) {
    throw new Error((cData.error && (cData.error.data?.reason || cData.error.message)) || `Challenge request failed (${cRes.status})`);
  }
  const message = cData.result?.messageToSign || cData.message || cData.challenge || cData.data?.message;
  const challengeId = cData.result?.challengeId;
  if (!message) throw new Error('No challenge message in response: ' + JSON.stringify(cData));

  const signature = await agentWallet.signMessage(message);

  const vRes = await fetch(RPC_BASE + '/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: agentWallet.address, chainId: "19042026", challengeId, message, signature })
  });
  const vData = await vRes.json();
  if (!vRes.ok || vData.error) {
    throw new Error((vData.error && vData.error.message) || `Verify request failed (${vRes.status})`);
  }
  accessToken = vData.result?.accessToken || vData.accessToken || vData.access_token || vData.token;
  refreshToken = vData.result?.refreshToken || vData.refreshToken || vData.refresh_token;
  if (!accessToken) throw new Error('Auth failed: no accessToken in ' + JSON.stringify(vData));
  tokenExpiry = Date.now() + 14 * 60 * 1000;
  log('Authenticated agent wallet with Interlink gateway.');
}

async function ensureAuth() {
  if (!accessToken || Date.now() > tokenExpiry) await authenticate();
}

async function rpcCall(method, params, _retried) {
  await ensureAuth();
  const res = await fetch(RPC_BASE + '/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  const data = await res.json();
  if (res.status === 401 && !_retried) {
    accessToken = null;
    await authenticate();
    return rpcCall(method, params, true);
  }
  if (res.status === 429 || data?.error?.key === 'RATE_LIMITED') {
    if (_retried) throw new Error('Still rate limited after one retry.');
    await new Promise(r => setTimeout(r, 1500));
    return rpcCall(method, params, true);
  }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { return []; }
}
function saveSchedules(s) { fs.writeFileSync(DB_FILE, JSON.stringify(s, null, 2)); }

async function sendNative(to, amountEth) {
  const nonceHex = await rpcCall('eth_getTransactionCount', [agentWallet.address, 'latest']);
  const gasPriceHex = await rpcCall('eth_gasPrice', []);
  let priorityHex;
  try { priorityHex = await rpcCall('eth_maxPriorityFeePerGas', []); }
  catch (e) { priorityHex = '0x3b9aca00'; }
  const tx = {
    type: 2, chainId: CHAIN_ID, nonce: Number(BigInt(nonceHex)),
    to, value: ethers.parseEther(amountEth), gasLimit: 21000n,
    maxFeePerGas: BigInt(gasPriceHex), maxPriorityFeePerGas: BigInt(priorityHex), data: '0x'
  };
  const raw = await agentWallet.signTransaction(tx);
  return rpcCall('eth_sendRawTransaction', [raw]);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendNativeAndConfirm(to, amountEth, maxWaitMs = 25000) {
  const hash = await sendNative(to, amountEth);
  let receipt = null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs && !receipt) {
    await sleep(1500);
    try { receipt = await rpcCall('eth_getTransactionReceipt', [hash]); } catch (e) {}
  }
  let confirmed = false;
  if (receipt) {
    const sentBlock = BigInt(receipt.blockNumber);
    const startB = Date.now();
    while (Date.now() - startB < 10000 && !confirmed) {
      try {
        const bn = BigInt(await rpcCall('eth_blockNumber', []));
        if (bn - sentBlock >= 2n) confirmed = true;
      } catch (e) {}
      if (!confirmed) await sleep(1500);
    }
  }
  return { hash, confirmed, blockNumber: receipt ? receipt.blockNumber : null };
}

app.post('/api/send', async (req, res) => {
  const { to, amountEth } = req.body;
  if (!to || !amountEth) return res.status(400).json({ error: 'to and amountEth required' });
  try {
    const result = await sendNativeAndConfirm(to, amountEth);
    log(`One-time send: ${amountEth} tITL -> ${to} (${result.hash}) confirmed=${result.confirmed}`);
    res.json(result);
  } catch (e) {
    log(`One-time send failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agent', async (req, res) => {
  try {
    const balHex = await rpcCall('eth_getBalance', [agentWallet.address, 'latest']);
    res.json({ address: agentWallet.address, balance: ethers.formatEther(BigInt(balHex)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/schedules', (req, res) => res.json(loadSchedules()));

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// dayOfWeek: 0=Sunday..6=Saturday. time: "HH:MM" in 24h UTC.
function nextWeeklyRun(dayOfWeek, time, from) {
  from = from || new Date();
  const [hh, mm] = time.split(':').map(Number);
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hh, mm, 0, 0));
  const diff = (dayOfWeek - target.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + diff);
  if (target.getTime() <= from.getTime()) target.setUTCDate(target.getUTCDate() + 7);
  return target.getTime();
}

app.post('/api/schedule', (req, res) => {
  const { to, amountEth, dayOfWeek, time } = req.body;
  if (!to || !amountEth || dayOfWeek === undefined || !time) {
    return res.status(400).json({ error: 'to, amountEth, dayOfWeek (0-6), time (HH:MM UTC) required' });
  }
  const dow = Number(dayOfWeek);
  if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'time must be HH:MM (24h, UTC)' });
  const schedules = loadSchedules();
  const job = {
    id: Date.now().toString(), to, amountEth,
    dayOfWeek: dow, time,
    nextRun: nextWeeklyRun(dow, time),
    lastTxHash: null, runs: 0
  };
  schedules.push(job);
  saveSchedules(schedules);
  log(`New schedule ${job.id}: ${amountEth} tITL -> ${to} every ${DAY_NAMES[dow]} ${time} UTC`);
  res.json(job);
});

app.delete('/api/schedule/:id', (req, res) => {
  const schedules = loadSchedules().filter(s => s.id !== req.params.id);
  saveSchedules(schedules);
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => res.json(logs.slice(-100)));

cron.schedule('* * * * *', async () => {
  const schedules = loadSchedules();
  const now = Date.now();
  let changed = false;
  for (const job of schedules) {
    if (job.nextRun <= now) {
      changed = true;
      try {
        const hash = await sendNative(job.to, job.amountEth);
        job.lastTxHash = hash;
        job.runs++;
        job.nextRun = job.nextRun + 7 * 24 * 60 * 60 * 1000; // same weekday/time, next week
        log(`Executed schedule ${job.id}: ${job.amountEth} tITL -> ${job.to} (${hash})`);
      } catch (e) {
        log(`Schedule ${job.id} failed: ${e.message}`);
      }
    }
  }
  if (changed) saveSchedules(schedules);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`Aether Flow scheduler backend running on port ${PORT}`));
