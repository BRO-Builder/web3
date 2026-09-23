import { TezosToolkit, MichelsonMap } from "https://esm.sh/@taquito/taquito@20";
import { Parser } from "https://esm.sh/@taquito/michel-codec@20";
import { BeaconWallet } from "https://esm.sh/@taquito/beacon-wallet@20";

const RPCS = {
  mainnet: "https://mainnet.api.tez.ie",
  ghostnet: "https://ghostnet.ecadinfra.com",
};

const $ = (id) => document.getElementById(id);
const networkSel = $("network"), customWrap = $("customRpcWrap"), customRpc = $("customRpc");
const connectBtn = $("connectBtn"), disconnectBtn = $("disconnectBtn"), walletInfo = $("walletInfo");
const deployBtn = $("deployBtn"), statusEl = $("status");

let Tezos, wallet, userAddress = null;

function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }
function currentRpc() { return networkSel.value === "custom" ? customRpc.value.trim() : RPCS[networkSel.value]; }

networkSel.addEventListener("change", () => {
  customWrap.style.display = networkSel.value === "custom" ? "block" : "none";
});

function toHexBytes(str) {
  return Array.from(new TextEncoder().encode(str)).map(b => b.toString(16).padStart(2, "0")).join("");
}

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Opening wallet connect...");
    const rpc = currentRpc();
    if (!rpc) { setStatus("Set an RPC URL first."); return; }
    Tezos = new TezosToolkit(rpc);
    wallet = new BeaconWallet({ name: "BRO Builder FT Deploy" });
    const netType = networkSel.value === "custom" ? "custom" : networkSel.value;
    const networkOpt = netType === "custom"
      ? { type: "custom", name: "Custom", rpcUrl: rpc }
      : { type: netType };
    await wallet.requestPermissions({ network: networkOpt });
    Tezos.setWalletProvider(wallet);
    userAddress = await wallet.getPKH();
    walletInfo.textContent = `Connected: ${userAddress} (${networkSel.value})`;
    connectBtn.style.display = "none";
    disconnectBtn.style.display = "inline-block";
    deployBtn.disabled = false;
    setStatus("Wallet connected.");
  } catch (err) {
    setStatus("Connect failed: " + (err?.message || err));
  }
});

disconnectBtn.addEventListener("click", async () => {
  if (wallet) await wallet.clearActiveAccount();
  userAddress = null;
  walletInfo.textContent = "";
  connectBtn.style.display = "inline-block";
  disconnectBtn.style.display = "none";
  deployBtn.disabled = true;
  setStatus("Disconnected.");
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

    const explorerBase = networkSel.value === "mainnet" ? "https://tzkt.io" : "https://ghostnet.tzkt.io";
    log("Deployed!");
    log("Contract address: " + contract.address);
    statusEl.innerHTML += `\n<a class="result" href="${explorerBase}/${contract.address}" target="_blank" rel="noopener">View on TzKT</a>`;
  } catch (err) {
    log("Deploy failed: " + (err?.message || err));
  } finally {
    deployBtn.disabled = !userAddress;
  }
});
