import { TezosToolkit, MichelsonMap } from "@taquito/taquito";
import { Parser } from "@taquito/michel-codec";
import { BeaconWallet } from "@taquito/beacon-wallet";

const RPCS = {
  mainnet: "https://tezos-mainnet.octez.io",
  shadownet: "https://rpc.shadownet.teztnets.com",
};

const TZ_FILE_URL = "https://static.eidoriantan.com/contracts/FA2.tz";

const $ = (id) => document.getElementById(id);
const networkSel = $("network"), customWrap = $("customRpcWrap"), customRpc = $("customRpc");
const connectBtn = $("connectBtn"), disconnectBtn = $("disconnectBtn"), walletInfo = $("walletInfo");
const deployBtn = $("deployBtn"), statusEl = $("status");
const contractCodeEl = $("contractCode"), reloadCodeBtn = $("reloadCodeBtn"), codeSpinnerRow = $("codeSpinnerRow");

let Tezos, wallet, userAddress = null;
let walletNetwork = null;

function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }
function currentRpc() { return networkSel.value === "custom" ? customRpc.value.trim() : RPCS[networkSel.value]; }

networkSel.addEventListener("change", () => {
  customWrap.style.display = networkSel.value === "custom" ? "block" : "none";
});

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

async function ensureWallet(rpc) {
  if (!Tezos) Tezos = new TezosToolkit(rpc);
  else Tezos.setRpcProvider(rpc);

  const netType = networkSel.value === "custom" ? "custom" : networkSel.value;
  const networkOpt = netType === "custom"
    ? { type: "custom", name: "Custom", rpcUrl: rpc }
    : { type: netType };

  if (!wallet || walletNetwork !== netType) {
    wallet = new BeaconWallet({
      name: "BRO Builder FT Deploy",
      network: networkOpt,
    });
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

// On load: if Beacon already has an active session from a previous visit,
// reflect that in the UI (including the ability to disconnect it). Also
// fetch the compiled contract code from the source link.
(async () => {
  try {
    const w = await ensureWallet(currentRpc());
    const active = await w.client.getActiveAccount();
    if (active) setConnectedUI(active.address, networkSel.value);
  } catch (err) {
    // no existing session, or storage unavailable — ignore
  }
  loadContractCode();
})();

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Opening wallet connect...");
    const rpc = currentRpc();
    if (!rpc) { setStatus("Set an RPC URL first."); return; }
    await ensureWallet(rpc);
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
    if (wallet) {
      await wallet.clearActiveAccount();
      Tezos = null;
      userAddress = null;
      wallet = null;
      walletNetwork = null;
    }
  } finally {
    setDisconnectedUI();
    setStatus("Disconnected.");
  }
});

deployBtn.addEventListener("click", async () => {
  try {
    const name = $("tokenName").value.trim();
    const symbol = $("tokenSymbol").value.trim();
    const code = $("contractCode").value.trim();
    if (!userAddress) { setStatus("Connect a wallet first."); return; }
    if (!name || !symbol) { setStatus("Enter both a token name and symbol."); return; }
    if (!code) { setStatus("Paste the compiled Michelson (.tz) code first."); return; }

    deployBtn.disabled = true;
    setStatus("Parsing contract code...");
    const parser = new Parser();
    const contractCode = parser.parseScript(code);

    const tokenInfo = new MichelsonMap();
    tokenInfo.set("name", toHexBytes(name));
    tokenInfo.set("symbol", toHexBytes(symbol));

    const tokenMetadata = new MichelsonMap();
    tokenMetadata.set(0, { token_id: 0, token_info: tokenInfo });

    const storage = {
      ledger: new MichelsonMap(),
      operators: new MichelsonMap(),
      token_ids: [0],
      token_metadata: tokenMetadata,
      token_supply: new MichelsonMap(),
      extension: {
        admin: userAddress,
        token_usage: new MichelsonMap(),
      },
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
    log("Deploy failed: " + (err?.message || err));
  } finally {
    deployBtn.disabled = !userAddress;
  }
});
