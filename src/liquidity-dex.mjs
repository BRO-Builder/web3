import { TezosToolkit } from "@taquito/taquito";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { validateAddress, ValidationResult } from "@taquito/utils";

const NETWORKS = [
  { value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet", explorer: "https://tzkt.io", api: "https://api.tzkt.io" },
  { value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet", explorer: "https://ghostnet.tzkt.io", api: "https://api.ghostnet.tzkt.io" },
  { value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet", explorer: "https://shadownet.tzkt.io", api: "https://api.shadownet.tzkt.io" },
];

const $ = (id) => document.getElementById(id);
const networkSel = $("network");
const connectBtn = $("connectBtn"), disconnectBtn = $("disconnectBtn"), walletInfo = $("walletInfo");
const statusEl = $("status");
const dexAddressEl = $("dexAddress"), loadDexBtn = $("loadDexBtn");
const poolInfoEl = $("poolInfo"), positionInfoEl = $("positionInfo");
const slippageEl = $("slippage");
const addXtzEl = $("addXtz"), addQuoteEl = $("addQuote"), addBtn = $("addBtn"), authorizeCheck = $("authorizeCheck");
const removeSharesEl = $("removeShares"), removeQuoteEl = $("removeQuote"), removeBtn = $("removeBtn");
const pctBtns = document.querySelectorAll(".pct");

let Tezos, wallet, userAddress = null, walletNetwork = null;
// pool: { address, contract, sharesMap, tokenAddress, tokenId, xtzPool, tokenPool, totalShares, initialized, token }
let pool = null;
let myShares = 0n;
let addQuote = null;    // { xtzIn, tokenIn, shares, minShares }
let removeQuote = null; // { shares, xtzOut, tokenOut, minXtz, minToken }

const net = () => NETWORKS.find((n) => n.value === networkSel.value);
function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }
function isKT1(a) { return a.startsWith("KT1") && validateAddress(a) === ValidationResult.VALID; }
const toBig = (bn) => BigInt(bn.toFixed());

function parseUnits(str, decimals) {
  str = str.trim();
  if (!/^\d*\.?\d*$/.test(str) || str === "" || str === ".") return null;
  const [whole, frac = ""] = str.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

function formatUnits(value, decimals) {
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${value / base}.${frac}` : (value / base).toString();
}

function slippageBps() {
  const s = Number(slippageEl.value);
  return s >= 0 && s <= 50 ? BigInt(Math.round(s * 100)) : null;
}

// ---- UI state ----
function refreshButtons() {
  const ready = !!pool && pool.initialized;
  addXtzEl.disabled = !ready;
  removeSharesEl.disabled = !ready || myShares === 0n;
  pctBtns.forEach((b) => (b.disabled = !ready || myShares === 0n));
  addBtn.disabled = !(ready && userAddress && addQuote);
  removeBtn.disabled = !(ready && userAddress && removeQuote);
}

function setConnectedUI(address, label) {
  userAddress = address;
  walletInfo.textContent = `Connected: ${address} (${label})`;
  connectBtn.style.display = "none";
  disconnectBtn.style.display = "inline-block";
  refreshPosition();
}

function setDisconnectedUI() {
  userAddress = null;
  myShares = 0n;
  walletInfo.textContent = "";
  connectBtn.style.display = "inline-block";
  disconnectBtn.style.display = "none";
  renderPosition();
  updateQuotes();
}

async function ensureWallet() {
  const rpc = net().rpc;
  if (!Tezos) Tezos = new TezosToolkit(rpc);
  else Tezos.setRpcProvider(rpc);

  const netType = networkSel.value;
  if (!wallet || walletNetwork !== netType) {
    wallet = new BeaconWallet({
      name: "BRO Builder Liquidity",
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

// ---- rendering ----
function renderPool() {
  if (!pool) { poolInfoEl.textContent = ""; return; }
  const t = pool.token;
  let text = `Token: ${t.symbol} (${pool.tokenAddress}, id ${pool.tokenId})\n`;
  text += pool.initialized
    ? `Reserves: ${formatUnits(pool.xtzPool, 6)} XTZ / ${formatUnits(pool.tokenPool, t.decimals)} ${t.symbol}\n` +
      `Total shares: ${pool.totalShares}`
    : "This pool has not been initialized yet. Use the pool setup page first.";
  poolInfoEl.textContent = text;
}

function renderPosition() {
  if (!pool || !pool.initialized || !userAddress) { positionInfoEl.textContent = ""; return; }
  if (myShares === 0n) { positionInfoEl.textContent = "Your position: no shares in this pool."; return; }
  const t = pool.token;
  const xtz = (pool.xtzPool * myShares) / pool.totalShares;
  const tok = (pool.tokenPool * myShares) / pool.totalShares;
  const pct = Number((myShares * 1000000n) / pool.totalShares) / 10000;
  positionInfoEl.textContent =
    `Your position: ${myShares} shares (${pct.toFixed(2)}% of the pool)\n` +
    `Redeemable now: ${formatUnits(xtz, 6)} XTZ + ${formatUnits(tok, t.decimals)} ${t.symbol}`;
}

function updateQuotes() {
  addQuote = null;
  removeQuote = null;
  addQuoteEl.textContent = "";
  removeQuoteEl.textContent = "";

  if (pool?.initialized) {
    const t = pool.token;
    const slip = slippageBps();

    if (addXtzEl.value.trim() !== "") {
      const xtzIn = parseUnits(addXtzEl.value, 6);
      if (xtzIn === null || xtzIn === 0n) {
        addQuoteEl.textContent = "Enter a positive XTZ amount with at most 6 decimals.";
      } else if (slip === null) {
        addQuoteEl.textContent = "Slippage must be between 0 and 50%.";
      } else {
        // same ratios as the contract's add_liquidity
        const tokenIn = (pool.tokenPool * xtzIn) / pool.xtzPool;
        const shares = (pool.totalShares * xtzIn) / pool.xtzPool;
        if (tokenIn === 0n || shares === 0n) {
          addQuoteEl.textContent = "Amount too small.";
        } else {
          const minShares = (shares * (10000n - slip)) / 10000n;
          addQuote = { xtzIn, tokenIn, shares, minShares };
          addQuoteEl.textContent =
            `You will deposit: ${formatUnits(tokenIn, t.decimals)} ${t.symbol} (approx.)\n` +
            `You will receive: ${shares} shares (minimum ${minShares})`;
        }
      }
    }

    if (removeSharesEl.value.trim() !== "") {
      const v = removeSharesEl.value.trim();
      if (!/^[1-9]\d*$/.test(v)) {
        removeQuoteEl.textContent = "Shares must be a positive whole number.";
      } else if (BigInt(v) > myShares) {
        removeQuoteEl.textContent = `You only hold ${myShares} shares.`;
      } else if (slip === null) {
        removeQuoteEl.textContent = "Slippage must be between 0 and 50%.";
      } else {
        const shares = BigInt(v);
        const xtzOut = (pool.xtzPool * shares) / pool.totalShares;
        const tokenOut = (pool.tokenPool * shares) / pool.totalShares;
        const minXtz = (xtzOut * (10000n - slip)) / 10000n;
        const minToken = (tokenOut * (10000n - slip)) / 10000n;
        removeQuote = { shares, xtzOut, tokenOut, minXtz, minToken };
        removeQuoteEl.textContent =
          `You will receive: ${formatUnits(xtzOut, 6)} XTZ + ${formatUnits(tokenOut, t.decimals)} ${t.symbol}\n` +
          `Minimum: ${formatUnits(minXtz, 6)} XTZ + ${formatUnits(minToken, t.decimals)} ${t.symbol}`;
      }
    }
  }
  refreshButtons();
}

// ---- data loading ----
async function fetchTokenInfo(address, tokenId) {
  try {
    const res = await fetch(`${net().api}/v1/tokens?contract=${address}&tokenId=${tokenId}&limit=1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [tok] = await res.json();
    const md = tok?.metadata || {};
    return {
      symbol: typeof md.symbol === "string" && md.symbol ? md.symbol : "TOKEN",
      decimals: Number.isInteger(Number(md.decimals)) ? Number(md.decimals) : 0,
    };
  } catch (err) {
    log("Could not read token metadata, showing raw units: " + (err?.message || err));
    return { symbol: "TOKEN", decimals: 0 };
  }
}

async function refreshPosition() {
  myShares = 0n;
  if (pool && userAddress) {
    try {
      const v = await pool.sharesMap.get(userAddress);
      myShares = v ? toBig(v) : 0n;
    } catch (err) {
      log("Could not read your shares: " + (err?.message || err));
    }
  }
  renderPosition();
  updateQuotes();
}

async function loadPool(address) {
  await ensureWallet();
  const contract = await Tezos.wallet.at(address);
  const s = await contract.storage();
  const tokenId = s.token_id.toString();
  const token = pool && pool.address === address ? pool.token : await fetchTokenInfo(s.token_address, tokenId);

  pool = {
    address,
    contract,
    sharesMap: s.shares,
    tokenAddress: s.token_address,
    tokenId,
    xtzPool: toBig(s.xtz_pool),
    tokenPool: toBig(s.token_pool),
    totalShares: toBig(s.total_shares),
    initialized: !s.total_shares.isZero(),
    token,
  };
  renderPool();
  await refreshPosition();
}

// ---- events ----
networkSel.addEventListener("change", () => {
  pool = null;
  myShares = 0n;
  renderPool();
  renderPosition();
  updateQuotes();
});

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Opening wallet connect...");
    await ensureWallet();
    await wallet.requestPermissions();
    setConnectedUI(await wallet.getPKH(), networkSel.value);
    setStatus("Wallet connected.");
  } catch (err) {
    setStatus("Connect failed: " + (err?.message || err));
  }
});

disconnectBtn.addEventListener("click", async () => {
  try {
    if (wallet) await wallet.clearActiveAccount();
    Tezos = null; userAddress = null; wallet = null; walletNetwork = null;
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
    setStatus("Reading pool...");
    await loadPool(address);
    setStatus(pool.initialized ? "Pool loaded." : "Pool loaded, but it is not initialized yet.");
  } catch (err) {
    console.error(err);
    pool = null;
    renderPool();
    renderPosition();
    updateQuotes();
    setStatus("Failed to load pool: " + (err?.message || err));
  } finally {
    loadDexBtn.disabled = false;
  }
});

dexAddressEl.addEventListener("input", () => dexAddressEl.classList.remove("invalid"));
[addXtzEl, removeSharesEl, slippageEl].forEach((el) => el.addEventListener("input", updateQuotes));

pctBtns.forEach((b) =>
  b.addEventListener("click", () => {
    const pct = BigInt(b.dataset.pct);
    const shares = (myShares * pct) / 100n;
    removeSharesEl.value = shares > 0n ? shares.toString() : "";
    updateQuotes();
  })
);

async function afterConfirm(op) {
  log("Op hash: " + op.opHash);
  log("Waiting for confirmation...");
  await op.confirmation();
  log(`${net().explorer}/${op.opHash}`);
  await loadPool(pool.address); // refresh reserves and position
}

addBtn.addEventListener("click", async () => {
  if (!addQuote || !pool) return;
  addBtn.disabled = true;
  try {
    await ensureWallet();
    const q = addQuote;
    setStatus(`Adding liquidity: ${formatUnits(q.xtzIn, 6)} XTZ + ~${formatUnits(q.tokenIn, pool.token.decimals)} ${pool.token.symbol}...`);

    const addCall = pool.contract.methodsObject.add_liquidity(q.minShares.toString());
    let op;

    if (authorizeCheck.checked) {
      const token = await Tezos.wallet.at(pool.tokenAddress);
      const authCall = token.methodsObject.update_operators([
        { add_operator: { owner: userAddress, operator: pool.address, token_id: pool.tokenId } },
      ]);
      // add_liquidity carries XTZ, so it goes into the batch as a transfer with an amount
      op = await Tezos.wallet.batch()
        .withContractCall(authCall)
        .withTransfer(addCall.toTransferParams({ amount: Number(q.xtzIn), mutez: true }))
        .send();
    } else {
      op = await addCall.send({ amount: Number(q.xtzIn), mutez: true });
    }

    await afterConfirm(op);
    log("Liquidity added.");
    addXtzEl.value = "";
    updateQuotes();
  } catch (err) {
    console.error(err);
    log("Add liquidity failed: " + (err?.message || err));
    log("If the pool ratio moved, reload the pool. Also check you hold enough tokens.");
  } finally {
    refreshButtons();
  }
});

removeBtn.addEventListener("click", async () => {
  if (!removeQuote || !pool) return;
  removeBtn.disabled = true;
  try {
    await ensureWallet();
    const q = removeQuote;
    setStatus(`Removing ${q.shares} shares...`);
    const op = await pool.contract.methodsObject.remove_liquidity({
      shares: q.shares.toString(),
      min_xtz: q.minXtz.toString(),
      min_token: q.minToken.toString(),
    }).send();

    await afterConfirm(op);
    log("Liquidity removed.");
    removeSharesEl.value = "";
    updateQuotes();
  } catch (err) {
    console.error(err);
    log("Remove liquidity failed: " + (err?.message || err));
    log("If the pool moved, reload the pool or raise the slippage tolerance.");
  } finally {
    refreshButtons();
  }
});
