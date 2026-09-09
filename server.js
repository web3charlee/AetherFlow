require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const cron = require('node-cron');
const fs = require('fs');

const RPC_BASE = 'https://evm-rpc.test-net.interlinklabs.ai/v1';
const CHAIN_ID = 19042026n;
const DB_FILE = './schedules.json';

const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));

// ---- agent wallet (server-side signer for unattended/recurring sends) ----
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
  const message = cData.result?.messageToSign || cData.message || cData.challenge || cData.data?.message;
  if (!message) throw new Error('No challenge message in response: ' + JSON.stringify(cData));

  const signature = await agentWallet.signMessage(message);

  const vRes = await fetch(RPC_BASE + '/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: agentWallet.address, chainId: "19042026", message, signature })
  });
  const vData = await vRes.json();
  accessToken = vData.result?.accessToken || vData.accessToken || vData.access_token || vData.token;
refreshToken = vData.result?.refreshToken || vData.refreshToken || vData.refresh_token;
  if (!accessToken) throw new Error('Auth failed: ' + JSON.stringify(vData));
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
    await new Promise(r => setTimeout(r, 1500));
    return rpcCall(method, params, _retried);
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

// ---- API ----
app.get('/api/agent', async (req, res) => {
  try {
    const balHex = await rpcCall('eth_getBalance', [agentWallet.address, 'latest']);
    res.json({ address: agentWallet.address, balance: ethers.formatEther(BigInt(balHex)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/schedules', (req, res) => res.json(loadSchedules()));

app.post('/api/schedule', (req, res) => {
  const { to, amountEth, intervalDays } = req.body;
  if (!to || !amountEth || !intervalDays) return res.status(400).json({ error: 'to, amountEth, intervalDays required' });
  const schedules = loadSchedules();
  const job = { id: Date.now().toString(), to, amountEth, intervalDays: Number(intervalDays), nextRun: Date.now(), lastTxHash: null, runs: 0 };
  schedules.push(job);
  saveSchedules(schedules);
  log(`New schedule ${job.id}: ${amountEth} tITL -> ${to} every ${intervalDays}d`);
  res.json(job);
});

app.delete('/api/schedule/:id', (req, res) => {
  const schedules = loadSchedules().filter(s => s.id !== req.params.id);
  saveSchedules(schedules);
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => res.json(logs.slice(-100)));

// ---- the part that actually makes it "live and kicking" while nobody's watching ----
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
        job.nextRun = now + job.intervalDays * 24 * 60 * 60 * 1000;
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
