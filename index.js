#!/usr/bin/env node
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ethers } from "ethers";
import inquirer from "inquirer";
import chalk from "chalk";
import fetch from "node-fetch";
dotenv.config();

// === File Paths ===
const __dirname = path.resolve();
const rpcPath = path.join(__dirname, "rpc.json");
const configPath = path.join(__dirname, "config.json");
const logDir = path.join(__dirname, "logs");
const logFile = path.join(logDir, "txlog.json");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, "[]");

// === Load Config ===
let RPCS = {}, CONFIG = {};
try {
  RPCS = JSON.parse(fs.readFileSync(rpcPath, "utf8"));
  CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (e) {
  console.error("❌ Gagal memuat rpc/config:", e.message);
  process.exit(1);
}

// === Helper ===
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toEth = v => ethers.formatEther(v);
const toGwei = v => ethers.formatUnits(v, "gwei");
function mulBigInt(b, f) {
  const s = String(f);
  if (!s.includes(".")) return b * BigInt(f);
  const d = s.split(".")[1].length;
  const p = BigInt(Math.round(f * 10 ** d));
  const q = BigInt(10 ** d);
  return (b * p) / q;
}

// === Logging ===
function writeLog(entry) {
  try {
    const logs = JSON.parse(fs.readFileSync(logFile, "utf8"));
    logs.push({ time: new Date().toISOString(), ...entry });
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal menulis log:", e.message);
  }
}

// === RPC/Relay ===
function getRpc(chainKey) {
  if (CONFIG.customRpc?.enabled && CONFIG.customRpc?.url)
    return CONFIG.customRpc.url;
  return RPCS[chainKey]?.rpc || null;
}
function getRelay(chainKey) {
  const entry = RPCS[chainKey] || {};
  if (CONFIG.relayPreference.useFlashbots && entry.relay_flashbots)
    return entry.relay_flashbots;
  if (CONFIG.relayPreference.useBloxroute && entry.relay_bloxroute)
    return entry.relay_bloxroute;
  if (CONFIG.relayPreference.useSelfRelay && CONFIG.apiKeys.selfRelay)
    return CONFIG.apiKeys.selfRelay;
  return null;
}

// === Relay Sender ===
async function sendViaRelay(relayUrl, rawTx, relayAuth) {
  const headers = { "Content-Type": "application/json" };
  if (relayAuth) headers["Authorization"] = relayAuth;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendRawTransaction",
    params: [rawTx]
  });
  const res = await fetch(relayUrl, { method: "POST", headers, body });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Relay error: ${res.statusText} ${txt}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

// === Fee Helper ===
async function getFee(provider, mult = 2) {
  const fd = await provider.getFeeData();
  let p = fd.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");
  let m = fd.maxFeePerGas;
  if (!m) {
    const b = await provider.getBlock("latest");
    m = (b?.baseFeePerGas ?? ethers.parseUnits("1", "gwei")) + p;
  }
  return {
    maxPriorityFeePerGas: mulBigInt(p, mult),
    maxFeePerGas: mulBigInt(m, mult)
  };
}

// === TX Sender (with bump) ===
async function sendWithBump({ provider, wallet, tx, relayUrl, relayAuth, mult = 1.5 }) {
  tx.nonce = await provider.getTransactionCount(wallet.address, "pending");
  let fee = await provider.getFeeData();
  let p = fee.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");
  let m = fee.maxFeePerGas ?? (await provider.getBlock("latest")).baseFeePerGas + p;
  tx.maxPriorityFeePerGas = mulBigInt(p, mult);
  tx.maxFeePerGas = mulBigInt(m, mult);

  for (let i = 0; i < 6; i++) {
    try {
      if (relayUrl) {
        const raw = await wallet.signTransaction(tx);
        console.log(chalk.yellow(`🔒 Sending via relay (${relayUrl})`));
        const out = await sendViaRelay(relayUrl, raw, relayAuth);
        writeLog({ type: "relay", relayUrl, tx, response: out });
        console.log(chalk.green("✅ Relay response:"), out);
        return out;
      }
      const sent = await wallet.sendTransaction(tx);
      console.log(chalk.yellow(`⏳ TX ${sent.hash} | tip ${toGwei(tx.maxPriorityFeePerGas)} gwei`));
      const rec = await sent.wait(1).catch(() => null);
      if (rec?.blockNumber) {
        writeLog({ type: "native", hash: sent.hash, block: rec.blockNumber, status: "success" });
        return rec;
      }
      process.stdout.write(`... bumping gas (${i + 1}/6)\r`);
      await sleep(3000);
      tx.maxPriorityFeePerGas = mulBigInt(tx.maxPriorityFeePerGas, 1.25);
      tx.maxFeePerGas = mulBigInt(tx.maxFeePerGas, 1.25);
    } catch (err) {
      console.log(chalk.red("⚠️ Error:"), err.message);
      writeLog({ type: "error", message: err.message, tx });
      await sleep(3000);
    }
  }
  throw new Error("TX gagal setelah 6 percobaan bump");
}

// === Send Native ===
async function sendNative(provider, wallet, to, amount, relayUrl, relayAuth, mult) {
  if (amount === "ALL") {
    while (true) {
      const bal = await provider.getBalance(wallet.address);
      if (bal <= 0n) {
        process.stdout.write(". polling balance...\r");
        await sleep(3000);
        continue;
      }
      const fee = await getFee(provider, mult);
      const gas = 21000n;
      const total = gas * fee.maxFeePerGas;
      if (bal <= total) {
        process.stdout.write(". not enough gas...\r");
        await sleep(3000);
        continue;
      }
      const val = bal - total;
      const tx = { to, value: val, gasLimit: gas };
      const rec = await sendWithBump({ provider, wallet, tx, relayUrl, relayAuth, mult });
      writeLog({ type: "native", to, value: toEth(val), hash: rec?.transactionHash || "-", chainId: (await provider.getNetwork()).chainId });
      return rec;
    }
  } else {
    const tx = { to, value: ethers.parseEther(amount), gasLimit: 21000n };
    const rec = await sendWithBump({ provider, wallet, tx, relayUrl, relayAuth, mult });
    writeLog({ type: "native", to, value: amount, hash: rec?.transactionHash || "-", chainId: (await provider.getNetwork()).chainId });
    return rec;
  }
}

// === Send Token ===
const ERC20 = [
  "function transfer(address to,uint256 amount)returns(bool)",
  "function balanceOf(address owner)view returns(uint256)",
  "function decimals()view returns(uint8)",
  "function symbol()view returns(string)"
];
async function sendToken(provider, wallet, tokenAddr, to, amount, relayUrl, relayAuth, mult) {
  const token = new ethers.Contract(tokenAddr, ERC20, wallet);
  const dec = await token.decimals();
  const sym = await token.symbol().catch(() => "TOKEN");
  if (amount === "ALL") {
    while (true) {
      const bal = await token.balanceOf(wallet.address);
      if (bal <= 0n) {
        process.stdout.write(`. waiting ${sym}...\r`);
        await sleep(3000);
        continue;
      }
      const iface = token.interface;
      const data = iface.encodeFunctionData("transfer", [to, bal]);
      const tx = { to: tokenAddr, data, gasLimit: 100000n };
      const rec = await sendWithBump({ provider, wallet, tx, relayUrl, relayAuth, mult });
      writeLog({ type: "token", token: sym, to, value: ethers.formatUnits(bal, dec), hash: rec?.transactionHash || "-", chainId: (await provider.getNetwork()).chainId });
      return rec;
    }
  } else {
    const val = ethers.parseUnits(amount, dec);
    const iface = token.interface;
    const data = iface.encodeFunctionData("transfer", [to, val]);
    const tx = { to: tokenAddr, data, gasLimit: 100000n };
    const rec = await sendWithBump({ provider, wallet, tx, relayUrl, relayAuth, mult });
    writeLog({ type: "token", token: sym, to, value: amount, hash: rec?.transactionHash || "-", chainId: (await provider.getNetwork()).chainId });
    return rec;
  }
}

// === Add Custom Network ===
async function addCustomNetwork() {
  console.clear();
  console.log(chalk.cyan("🆕 Tambah jaringan custom ke rpc.json\n"));
  const { key, name, rpc, relay } = await inquirer.prompt([
    { name: "key", message: "ID singkat (misal: monad, zora, opbnb):" },
    { name: "name", message: "Nama jaringan lengkap:" },
    { name: "rpc", message: "RPC URL:" },
    { name: "relay", message: "Relay URL (opsional):", default: "" }
  ]);

  const newEntry = { name, rpc };
  if (relay) newEntry.relay_bloxroute = relay;
  RPCS[key] = newEntry;
  fs.writeFileSync(rpcPath, JSON.stringify(RPCS, null, 2));
  console.log(chalk.green(`✅ ${name} berhasil disimpan di rpc.json`));
  process.exit(0);
}

// === MAIN ===
console.clear();
console.log(chalk.cyan.bold("🚀 Auto Token CLI — Multi EVM + Relay + Auto Logging\n"));

async function main() {
  const chains = Object.keys(RPCS).map(k => ({ name: RPCS[k].name, value: k }));
  chains.push({ name: "🆕 Tambah jaringan custom", value: "custom_add" });

  const a = await inquirer.prompt([
    { name: "chain", type: "list", message: "Pilih jaringan:", choices: chains, default: CONFIG.defaultChain }
  ]);

  if (a.chain === "custom_add") return addCustomNetwork();

  const b = await inquirer.prompt([
    { name: "privateKey", message: "Masukkan Private Key:", mask: "*", default: process.env.PRIVATE_KEY },
    { name: "type", type: "list", message: "Jenis pengiriman:", choices: ["Native Coin", "Token ERC20"] },
    { name: "to", message: "Alamat tujuan:" },
    { name: "amount", message: "Jumlah (atau ALL):", default: "ALL" },
    { name: "mult", message: "Gas multiplier (1–3):", default: "2" }
  ]);

  const rpc = getRpc(a.chain);
  const relayUrl = getRelay(a.chain);
  const relayAuth = CONFIG.apiKeys?.bloxroute ? `Bearer ${CONFIG.apiKeys.bloxroute}` : null;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(b.privateKey, provider);

  console.log(chalk.gray(`\n🔗 RPC: ${rpc}`));
  if (relayUrl) console.log(chalk.gray(`🚀 Relay: ${relayUrl}`));

  const mult = parseFloat(b.mult);
  if (b.type === "Native Coin")
    await sendNative(provider, wallet, b.to, b.amount, relayUrl, relayAuth, mult);
  else {
    const { tokenAddr } = await inquirer.prompt([{ name: "tokenAddr", message: "Alamat contract token ERC20:" }]);
    await sendToken(provider, wallet, tokenAddr, b.to, b.amount, relayUrl, relayAuth, mult);
  }

  console.log(chalk.green("\n✅ Transaksi selesai — lihat logs/txlog.json"));
}

main().catch(e => console.error(chalk.red("❌ Error:"), e.message));
