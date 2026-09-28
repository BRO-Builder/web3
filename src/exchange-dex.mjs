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
const dexAddressEl = $("dexAddress"), loadDexBtn = $("loadDexBtn"), poolInfoEl = $("poolInfo");
const amountInEl = $("amountIn"), amountOutEl = $("amountOut"), slippageEl = $("slippage");
const labelInEl = $("labelIn"), labelOutEl = $("labelOut"), quoteInfoEl = $("quoteInfo");
const flipBtn = $("flipBtn"), swapBtn = $("swapBtn");
const operatorRow = $("operatorRow"), authorizeCheck = $("authorizeCheck");

const XTZ = { symbol: "XTZ", decimals: 6 };

let Tezos, wallet, userAddress = null, walletNetwork = null;
// pool: { address, contract, tokenAddress, tokenId, feeBps, xtzPool, tokenPool, initialized, token: {symbol, decimals} }
let pool = null;
let xtzToToken = true; // swap direction
let quote = null;      // { amountIn, out, minOut }

const net = () => NETWORKS.find((n) => n.value === networkSel.value);
function log(msg) { statusEl.textContent += "\n" + msg; statusEl.scrollTop = statusEl.scrollHeight; }
function setStatus(msg) { statusEl.textContent = msg; }
function isKT1(a) { return a.startsWith("KT1") && validateAddress(a) === ValidationResult.VALID; }

// ---- amount helpers (BigInt, exact) ----
function parseUnits(str, decimals) {
  str = str.trim();
  if (!/^\d*\.?\d*$/.test(str) || str === "" || str === ".") return null;
  const [whole, frac = ""] = str.split(".");
  if (frac.length > decimals) return null; // too many decimals
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

function formatUnits(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const toBig = (bn) => BigInt(bn.toFixed());

// ---- UI state ----
function refreshButtons() {
  const ready = !!pool && pool.initialized;
  amountInEl.disabled = !ready;
  flipBtn.disabled = !ready;
  swapBtn.disabled = !(ready && userAddress && quote);
  operatorRow.style.display = ready && !xtzToToken ? "block" : "none";
}

function setConnectedUI(address, label) {
  userAddress = address;
  walletInfo.textContent = `Connected: ${address} (${label})`;
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
  const rpc = net().rpc;
  if (!Tezos) Tezos = new TezosToolkit(rpc);
  else Tezos.setRpcProvider(rpc);

  const netType = networkSel.value;
  if (!wallet || walletNetwork !== netType) {
    wallet = new BeaconWallet({
      name: "BRO Builder Exchange",
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

function sides() {
  const token = pool.token;
  return xtzToToken
    ? { inn: XTZ, out: token, reserveIn: pool.xtzPool, reserveOut: pool.tokenPool }
    : { inn: token, out: XTZ, reserveIn: pool.tokenPool, reserveOut: pool.xtzPool };
}

function renderPool() {
  if (!pool) { poolInfoEl.textContent = ""; return; }
  const t = pool.token;
  let text =
    `Token: ${t.symbol} (${pool.tokenAddress}, id ${pool.tokenId})\n` +
    `Fee: ${Number(pool.feeBps) / 100}%\n`;
  if (pool.initialized) {
    text += `Reserves: ${formatUnits(pool.xtzPool, 6)} XTZ / ${formatUnits(pool.tokenPool, t.decimals)} ${t.symbol}`;
  } else {
    text += "This pool has not been initialized yet. Use the pool setup page first.";
  }
  poolInfoEl.textContent = text;
}

function renderLabels() {
  if (!pool) return;
  const { inn, out } = sides();
  labelInEl.textContent = `You pay (${inn.symbol})`;
  labelOutEl.textContent = `You receive, estimated (${out.symbol})`;
}

let quoteSeq = 0;
let quoteTimer = null;

function clearQuote() {
  quote = null;
  amountOutEl.value = "";
  quoteInfoEl.textContent = "";
}

// Called on every keystroke: invalidate the old quote right away, fetch a new one after a short pause.
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteSeq++;
  clearQuote();
  refreshButtons();
  quoteTimer = setTimeout(updateQuote, 300);
}

// Quotes come from the DEX's on-chain views, so they always match the contract's own pricing.
async function updateQuote() {
  clearTimeout(quoteTimer);
  const seq = ++quoteSeq;
  clearQuote();

  if (pool?.initialized && amountInEl.value.trim() !== "") {
    const { inn, out, reserveIn, reserveOut } = sides();
    const amountIn = parseUnits(amountInEl.value, inn.decimals);
    const slippage = Number(slippageEl.value);

    if (amountIn === null || amountIn === 0n) {
      quoteInfoEl.textContent = `Enter a positive amount with at most ${inn.decimals} decimals.`;
    } else if (!(slippage >= 0 && slippage <= 50)) {
      quoteInfoEl.textContent = "Slippage must be between 0 and 50%.";
    } else {
      quoteInfoEl.textContent = "Fetching quote...";
      try {
        const view = xtzToToken
          ? pool.contract.contractViews.get_price_xtz_to_token(amountIn.toString())
          : pool.contract.contractViews.get_price_token_to_xtz(amountIn.toString());
        const result = await view.executeView({ viewCaller: userAddress || pool.address });
        if (seq !== quoteSeq) return; // a newer quote request superseded this one

        const outAmount = toBig(result);
        if (outAmount <= 0n || outAmount >= reserveOut) {
          quoteInfoEl.textContent = "Amount too small, or larger than the pool can fill.";
        } else {
          const slippageBps = BigInt(Math.round(slippage * 100));
          const minOut = (outAmount * (10000n - slippageBps)) / 10000n;
          const ideal = (amountIn * reserveOut) / reserveIn; // zero-fee, zero-impact output (display only)
          const impactBps = ideal > 0n ? ((ideal - outAmount) * 10000n) / ideal : 0n;
          quote = { amountIn, out: outAmount, minOut };
          amountOutEl.value = formatUnits(outAmount, out.decimals);
          quoteInfoEl.textContent =
            `Minimum received: ${formatUnits(minOut, out.decimals)} ${out.symbol}\n` +
            `Price impact (incl. fee): ${(Number(impactBps) / 100).toFixed(2)}%`;
        }
      } catch (err) {
        if (seq !== quoteSeq) return;
        console.error(err);
        quoteInfoEl.textContent = "Could not fetch quote: " + (err?.message || err);
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

async function loadPool(address) {
  await ensureWallet();
  const contract = await Tezos.wallet.at(address);
  const s = await contract.storage();
  const tokenId = s.token_id.toString();
  const prev = pool && pool.address === address ? pool.token : null;
  const token = prev || (await fetchTokenInfo(s.token_address, tokenId));

  pool = {
    address,
    contract,
    tokenAddress: s.token_address,
    tokenId,
    feeBps: toBig(s.fee_bps),
    xtzPool: toBig(s.xtz_pool),
    tokenPool: toBig(s.token_pool),
    initialized: !s.total_shares.isZero(),
    token,
  };
  renderPool();
  renderLabels();
  updateQuote();
}

// ---- events ----
networkSel.addEventListener("change", () => {
  pool = null;
  renderPool();
  updateQuote();
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
    updateQuote();
    setStatus("Failed to load pool: " + (err?.message || err));
  } finally {
    loadDexBtn.disabled = false;
  }
});

dexAddressEl.addEventListener("input", () => dexAddressEl.classList.remove("invalid"));
amountInEl.addEventListener("input", scheduleQuote);
slippageEl.addEventListener("input", scheduleQuote);

flipBtn.addEventListener("click", () => {
  xtzToToken = !xtzToToken;
  amountInEl.value = "";
  renderLabels();
  updateQuote();
});

swapBtn.addEventListener("click", async () => {
  if (!quote || !pool) return;
  swapBtn.disabled = true;
  try {
    await ensureWallet();
    const { inn, out } = sides();
    const q = quote;
    setStatus(
      `Swapping ${formatUnits(q.amountIn, inn.decimals)} ${inn.symbol} for at least ` +
      `${formatUnits(q.minOut, out.decimals)} ${out.symbol}...`
    );

    const dex = pool.contract;
    let op;

    if (xtzToToken) {
      op = await dex.methodsObject
        .xtz_to_token(q.minOut.toString())
        .send({ amount: Number(q.amountIn), mutez: true });
    } else {
      const swapCall = dex.methodsObject.token_to_xtz({
        token_amount: q.amountIn.toString(),
        min_xtz_out: q.minOut.toString(),
      });

      if (authorizeCheck.checked) {
        const token = await Tezos.wallet.at(pool.tokenAddress);
        const authCall = token.methodsObject.update_operators([
          { add_operator: { owner: userAddress, operator: pool.address, token_id: pool.tokenId } },
        ]);
        op = await Tezos.wallet.batch()
          .withContractCall(authCall)
          .withContractCall(swapCall)
          .send();
      } else {
        op = await swapCall.send();
      }
    }

    log("Op hash: " + op.opHash);
    log("Waiting for confirmation...");
    await op.confirmation();
    log("Swap complete.");
    log(`${net().explorer}/${op.opHash}`);

    amountInEl.value = "";
    await loadPool(pool.address); // refresh reserves
  } catch (err) {
    console.error(err);
    log("Swap failed: " + (err?.message || err));
    log("If the price moved, reload the pool or raise the slippage tolerance.");
  } finally {
    refreshButtons();
  }
});
