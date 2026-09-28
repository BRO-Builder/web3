import { TezosToolkit } from "@taquito/taquito";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { validateAddress, ValidationResult } from "@taquito/utils";

const RPCs = [
  { label: "Mainnet", value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet", explorer: "https://tzkt.io" },
  { label: "Ghostnet", value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet", explorer: "https://ghostnet.tzkt.io" },
  { label: "Shadownet", value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet", explorer: "https://shadownet.tzkt.io" },
];

const $ = (id) => document.getElementById(id);
const networkSel = $("network");
const connectBtn = $("connectBtn"), disconnectBtn = $("disconnectBtn"), walletInfo = $("walletInfo");
const statusEl = $("status");
const dexAddressEl = $("dexAddress"), loadDexBtn = $("loadDexBtn"), dexInfoEl = $("dexInfo");
const operatorBtn = $("operatorBtn"), initBtn = $("initBtn");
const tokenAmountEl = $("tokenAmount"), xtzAmountEl = $("xtzAmount");

let Tezos, wallet, userAddress = null;
let walletNetwork = null;
let dex = null; // { address, tokenAddress, tokenId, initialized }

function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }
function explorerBase() { return RPCs.find(r => r.value === networkSel.value)?.explorer; }

function isKT1(addr) {
  return addr.startsWith("KT1") && validateAddress(addr) === ValidationResult.VALID;
}

function refreshButtons() {
  const ready = !!userAddress && !!dex;
  operatorBtn.disabled = !ready;
  initBtn.disabled = !ready || dex.initialized;
}

function setConnectedUI(address, networkLabel) {
  userAddress = address;
  walletInfo.textContent = `Connected: ${address} (${networkLabel})`;
  connectBtn.style.display = "none";
  disconnectBtn.style.display = "inline-block";
  refreshButtons();
}

function setDisconnectedUI() {
  userAddress = null;
  walletInfo.textContent = "";
  connectBtn.style.display = "inline-block";
  disconnectBtn.style.display = "none";
  refreshButtons();
}

async function ensureWallet() {
  const rpc = RPCs.find(r => r.value === networkSel.value)?.rpc;
  if (!Tezos) Tezos = new TezosToolkit(rpc);
  else Tezos.setRpcProvider(rpc);

  const netType = networkSel.value;
  if (!wallet || walletNetwork !== netType) {
    wallet = new BeaconWallet({
      name: "BRO Builder DEX Setup",
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

// A different network means a different DEX contract, so drop the loaded one.
networkSel.addEventListener("change", () => {
  dex = null;
  dexInfoEl.textContent = "";
  refreshButtons();
});

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

loadDexBtn.addEventListener("click", async () => {
  const address = dexAddressEl.value.trim();
  if (!isKT1(address)) {
    dexAddressEl.classList.add("invalid");
    setStatus("Enter a valid DEX contract address (KT1...).");
    return;
  }
  dexAddressEl.classList.remove("invalid");

  loadDexBtn.disabled = true;
  try {
    await ensureWallet();
    setStatus("Reading DEX storage...");
    const contract = await Tezos.wallet.at(address);
    const storage = await contract.storage();

    dex = {
      address,
      tokenAddress: storage.token_address,
      tokenId: storage.token_id.toString(),
      initialized: !storage.total_shares.isZero(),
    };

    dexInfoEl.textContent =
      `Token contract: ${dex.tokenAddress}\n` +
      `Token ID: ${dex.tokenId}\n` +
      `Pool: ${dex.initialized ? "already initialized" : "not initialized"}`;
    setStatus(dex.initialized
      ? "DEX loaded. The pool is already initialized, so only the operator step is available."
      : "DEX loaded.");
  } catch (err) {
    console.error(err);
    dex = null;
    dexInfoEl.textContent = "";
    setStatus("Failed to load DEX: " + (err?.message || err));
  } finally {
    loadDexBtn.disabled = false;
    refreshButtons();
  }
});

function logOpLink(hash) {
  log("Op hash: " + hash);
}

operatorBtn.addEventListener("click", async () => {
  operatorBtn.disabled = true;
  try {
    await ensureWallet();
    setStatus("Preparing update_operators...");
    const token = await Tezos.wallet.at(dex.tokenAddress);
    const op = await token.methodsObject.update_operators([
      {
        add_operator: {
          owner: userAddress,
          operator: dex.address,
          token_id: dex.tokenId,
        },
      },
    ]).send();
    logOpLink(op.opHash);
    log("Waiting for confirmation...");
    await op.confirmation();
    log("Done. The DEX is now an operator of " + userAddress + " for token " + dex.tokenId + ".");
    log(`${explorerBase()}/${op.opHash}`);
  } catch (err) {
    console.error(err);
    log("update_operators failed: " + (err?.message || err));
  } finally {
    refreshButtons();
  }
});

initBtn.addEventListener("click", async () => {
  const tokenAmount = tokenAmountEl.value.trim();
  const xtzAmount = xtzAmountEl.value.trim();

  if (!/^[1-9]\d*$/.test(tokenAmount)) {
    tokenAmountEl.classList.add("invalid");
    setStatus("Token amount must be a positive whole number.");
    return;
  }
  if (!(Number(xtzAmount) > 0)) {
    xtzAmountEl.classList.add("invalid");
    setStatus("XTZ amount must be greater than 0.");
    return;
  }
  tokenAmountEl.classList.remove("invalid");
  xtzAmountEl.classList.remove("invalid");

  initBtn.disabled = true;
  try {
    await ensureWallet();
    setStatus(`Initializing pool with ${tokenAmount} tokens and ${xtzAmount} XTZ...`);
    const contract = await Tezos.wallet.at(dex.address);
    const op = await contract.methodsObject.initialize_pool(tokenAmount).send({ amount: xtzAmount });
    logOpLink(op.opHash);
    log("Waiting for confirmation...");
    await op.confirmation();
    dex.initialized = true;
    dexInfoEl.textContent = dexInfoEl.textContent.replace("not initialized", "already initialized");
    log("Pool initialized.");
    log(`${explorerBase()}/${dex.address}`);
  } catch (err) {
    console.error(err);
    log("initialize_pool failed: " + (err?.message || err));
    log("Check that you ran the Authorize step and hold enough tokens.");
  } finally {
    refreshButtons();
  }
});

[dexAddressEl, tokenAmountEl, xtzAmountEl].forEach((el) =>
  el.addEventListener("input", () => el.classList.remove("invalid"))
);
