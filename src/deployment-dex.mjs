import { TezosToolkit, MichelsonMap } from "@taquito/taquito";
import { Parser } from "@taquito/michel-codec";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { validateAddress, ValidationResult } from "@taquito/utils";

import { toHexBytes } from "./default.mjs";

const RPCs = [
  { label: "Mainnet", value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet", explorer: "https://tzkt.io" },
  { label: "Ghostnet", value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet", explorer: "https://ghostnet.tzkt.io" },
  { label: "Shadownet", value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet", explorer: "https://shadownet.tzkt.io" },
];

const TZ_FILE_URL = "https://static.eidoriantan.com/contracts/brodex.tz";

const $ = (id) => document.getElementById(id);
const networkSel = $("network");
const connectBtn = $("connectBtn"), disconnectBtn = $("disconnectBtn"), walletInfo = $("walletInfo");
const deployBtn = $("deployBtn"), statusEl = $("status");
const contractCodeEl = $("contractCode"), reloadCodeBtn = $("reloadCodeBtn"), codeSpinnerRow = $("codeSpinnerRow");
const adminEl = $("adminAddress"), tokenAddressEl = $("tokenAddress");

let Tezos, wallet, userAddress = null;
let walletNetwork = null;

function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }

function isValidAddress(addr) {
  return validateAddress(addr) === ValidationResult.VALID;
}

function setConnectedUI(address, networkLabel) {
  userAddress = address;
  walletInfo.textContent = `Connected: ${address} (${networkLabel})`;
  connectBtn.style.display = "none";
  disconnectBtn.style.display = "inline-block";
  deployBtn.disabled = false;
}

function setDisconnectedUI() {
  userAddress = null;
  walletInfo.textContent = "";
  connectBtn.style.display = "inline-block";
  disconnectBtn.style.display = "none";
  deployBtn.disabled = true;
}

async function ensureWallet() {
  const rpc = RPCs.find(r => r.value === networkSel.value)?.rpc;
  if (!Tezos) Tezos = new TezosToolkit(rpc);
  else Tezos.setRpcProvider(rpc);

  const netType = networkSel.value;
  if (!wallet || walletNetwork !== netType) {
    wallet = new BeaconWallet({
      name: "BRO Builder DEX Deploy",
      iconUrl: "https://www.brobuilder.llc/images/logo2.png",
      network: { type: netType },
    });
    await wallet.clearActiveAccount();
    Tezos.setWalletProvider(wallet);
    walletNetwork = netType;

    wallet.client.subscribeToEvent("ACTIVE_ACCOUNT_SET", (account) => {
      if (account) setConnectedUI(account.address, networkSel.value);
      else setDisconnectedUI();
    });
  }

  return wallet;
}

async function loadContractCode() {
  codeSpinnerRow.style.display = "flex";
  contractCodeEl.value = "";
  reloadCodeBtn.disabled = true;
  try {
    const res = await fetch(TZ_FILE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    contractCodeEl.value = text;
    log("Contract code loaded from source link.");
  } catch (err) {
    log("Failed to fetch contract code: " + (err?.message || err));
    contractCodeEl.value = "";
  } finally {
    codeSpinnerRow.style.display = "none";
    reloadCodeBtn.disabled = false;
  }
}

reloadCodeBtn.addEventListener("click", loadContractCode);

loadContractCode();

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Opening wallet connect...");
    await ensureWallet();
    await wallet.requestPermissions();
    const address = await wallet.getPKH();
    setConnectedUI(address, networkSel.value);
    setStatus("Wallet connected.");
  } catch (err) {
    setStatus("Connect failed: " + (err?.message || err));
  }
});

disconnectBtn.addEventListener("click", async () => {
  try {
    if (wallet) await wallet.clearActiveAccount();

    Tezos = null;
    userAddress = null;
    wallet = null;
    walletNetwork = null;
  } finally {
    setDisconnectedUI();
    setStatus("Disconnected.");
  }
});

// Clear the red border once the user edits a flagged field.
[adminEl, tokenAddressEl, $("tokenId"), $("feeBps")].forEach((el) =>
  el.addEventListener("input", () => el.classList.remove("invalid"))
);

function fail(el, msg) {
  el.classList.add("invalid");
  setStatus(msg);
  el.focus();
}

deployBtn.addEventListener("click", async () => {
  try {
    if (!userAddress) { setStatus("Connect a wallet first."); return; }

    const tokenAddress = tokenAddressEl.value.trim();
    const tokenId = parseInt($("tokenId").value.trim(), 10);
    const feeBps = parseInt($("feeBps").value.trim(), 10);
    const admin = adminEl.value.trim() || userAddress;
    const code = contractCodeEl.value.trim();

    if (!code) { setStatus("Contract code has not been loaded. Click Reload."); return; }
    if (!tokenAddress.startsWith("KT1") || !isValidAddress(tokenAddress)) {
      return fail(tokenAddressEl, "Enter a valid FA2 token contract address (KT1...).");
    }
    if (!Number.isInteger(tokenId) || tokenId < 0) {
      return fail($("tokenId"), "Token ID must be a non-negative integer.");
    }
    // Fee above 100% would underflow (as_nat) on every swap, so block it here.
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
      return fail($("feeBps"), "Fee must be between 0 and 10000 basis points.");
    }
    if (!isValidAddress(admin)) return fail(adminEl, "Invalid admin address.");

    await ensureWallet();
    deployBtn.disabled = true;
    setStatus("Parsing contract code...");
    const parser = new Parser();
    const contractCode = parser.parseScript(code);

    const contractMetadata = new MichelsonMap();
    contractMetadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-DEX.json"));

    const storage = {
      metadata: contractMetadata,
      admin,
      fee_bps: feeBps,
      shares: new MichelsonMap(),
      token_address: tokenAddress,
      token_id: tokenId,
      token_pool: 0,
      total_shares: 0,
      xtz_pool: 0, // mutez
    };

    log(`Admin: ${admin}`);
    log(`Token: ${tokenAddress} (id ${tokenId}), fee ${feeBps} bps`);
    log("Sending origination...");
    const op = await Tezos.wallet.originate({ code: contractCode, storage }).send();
    log("Op hash: " + op.opHash);
    log("Waiting for confirmation...");
    await op.confirmation();
    const contract = await op.contract();

    const explorerBase = RPCs.find(r => r.value === networkSel.value)?.explorer;
    log("Deployed!");
    log("Contract address: " + contract.address);

    const link = document.createElement("a");
    link.className = "result";
    link.href = `${explorerBase}/${contract.address}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View on TzKT";
    statusEl.appendChild(document.createTextNode("\n"));
    statusEl.appendChild(link);
    log("\nNext: call update_operators on the token contract, then initialize_pool on the DEX.");
  } catch (err) {
    console.error(err);
    log("Deploy failed: " + (err?.message || err));
  } finally {
    deployBtn.disabled = !userAddress;
  }
});
