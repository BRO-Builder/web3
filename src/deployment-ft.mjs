import { TezosToolkit, MichelsonMap } from "@taquito/taquito";
import { Parser } from "@taquito/michel-codec";
import { BeaconWallet } from "@taquito/beacon-wallet";

const RPCs = [
  { label: "Mainnet", value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet" },
  { label: "Ghostnet", value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet" },
  { label: "Shadownet", value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet" },
];

const TZ_FILE_URL = "https://static.eidoriantan.com/contracts/brotoken.tz";

const $ = (id) => document.getElementById(id);
const networkSel = $("network");
const connectBtn = $("connectBtn"), disconnectBtn = $("disconnectBtn"), walletInfo = $("walletInfo");
const deployBtn = $("deployBtn"), statusEl = $("status");
const contractCodeEl = $("contractCode"), reloadCodeBtn = $("reloadCodeBtn"), codeSpinnerRow = $("codeSpinnerRow");

let Tezos, wallet, userAddress = null;
let walletNetwork = null;

function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }

function toHexBytes(str) {
  return Array.from(new TextEncoder().encode(str)).map(b => b.toString(16).padStart(2, "0")).join("");
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
      name: "BRO Builder FT Deploy",
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

deployBtn.addEventListener("click", async () => {
  try {
    await ensureWallet();
    const name = $("tokenName").value.trim();
    const symbol = $("tokenSymbol").value.trim();
    const decimals = parseInt($("tokenDecimals").value.trim(), 10);
    const totalSupply = parseInt($("tokenSupply").value.trim(), 10);
    const description = $("tokenDescription").value.trim();
    const thumbnail = $("tokenThumbnail").value.trim();
    const code = $("contractCode").value.trim();
    if (!userAddress) { setStatus("Connect a wallet first."); return; }
    if (!code) { setStatus("Paste the compiled Michelson (.tz) code first."); return; }
    if (!totalSupply) { setStatus("Enter the total supply."); return; }
    if (!name || !symbol || !decimals) {
      setStatus("Enter token name, symbol, and decimals.");
      return;
    }

    deployBtn.disabled = true;
    setStatus("Parsing contract code...");
    const parser = new Parser();
    const contractCode = parser.parseScript(code);

    const tokenInfo = new MichelsonMap();
    tokenInfo.set("name", toHexBytes(name));
    tokenInfo.set("symbol", toHexBytes(symbol));
    tokenInfo.set("decimals", toHexBytes(decimals.toString()));
    if (description) tokenInfo.set("description", toHexBytes(description));
    if (thumbnail) tokenInfo.set("thumbnailUri", toHexBytes(thumbnail));
    tokenInfo.set("shouldPreferSymbol", toHexBytes("true"));

    const tokenMetadata = new MichelsonMap();
    tokenMetadata.set(0, { token_id: 0, token_info: tokenInfo });

    const contractMetadata = new MichelsonMap();
    contractMetadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-BRO.json"));

    const ledger = new MichelsonMap();
    ledger.set({ 0: userAddress, 1: 0 }, totalSupply);

    const supply = new MichelsonMap();
    supply.set(0, totalSupply);

    const storage = {
      ledger: ledger,
      metadata: contractMetadata,
      next_token_id: 1,
      operators: new MichelsonMap(),
      supply: supply,
      token_metadata: tokenMetadata,
    };

    log("Sending origination...");
    const op = await Tezos.wallet.originate({ code: contractCode, storage }).send();
    log("Op hash: " + op.opHash);
    log("Waiting for confirmation...");
    await op.confirmation();
    const contract = await op.contract();

    const explorerBase = networkSel.value === "mainnet" ? "https://tzkt.io" : "https://shadownet.tzkt.io";
    log("Deployed!");
    log("Contract address: " + contract.address);
    statusEl.innerHTML += `\n<a class="result" href="${explorerBase}/${contract.address}" target="_blank" rel="noopener">View on TzKT</a>`;
  } catch (err) {
    console.error(err);
    log("Deploy failed: " + (err?.message || err));
  } finally {
    deployBtn.disabled = !userAddress;
  }
});
