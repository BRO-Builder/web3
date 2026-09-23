(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(require('https://esm.sh/@taquito/taquito@20'), require('https://esm.sh/@taquito/michel-codec@20'), require('https://esm.sh/@taquito/beacon-wallet@20')) :
  typeof define === 'function' && define.amd ? define(['https://esm.sh/@taquito/taquito@20', 'https://esm.sh/@taquito/michel-codec@20', 'https://esm.sh/@taquito/beacon-wallet@20'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.taquito_20, global.michelCodec_20, global.beaconWallet_20));
})(this, (function (taquito_20, michelCodec_20, beaconWallet_20) { 'use strict';

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
    if (!Tezos) Tezos = new taquito_20.TezosToolkit(rpc);
    else Tezos.setRpcProvider(rpc);
    if (!wallet) {
      wallet = new beaconWallet_20.BeaconWallet({ name: "BRO Builder FT Deploy" });
      Tezos.setWalletProvider(wallet);
    }
    return wallet;
  }

  // On load: if Beacon already has an active session from a previous visit,
  // reflect that in the UI (including the ability to disconnect it).
  (async () => {
    try {
      const w = await ensureWallet(currentRpc());
      const active = await w.client.getActiveAccount();
      if (active) setConnectedUI(active.address, networkSel.value);
    } catch (err) {
      // no existing session, or storage unavailable — ignore
    }
  })();

  connectBtn.addEventListener("click", async () => {
    try {
      setStatus("Opening wallet connect...");
      const rpc = currentRpc();
      if (!rpc) { setStatus("Set an RPC URL first."); return; }
      await ensureWallet(rpc);
      const netType = networkSel.value === "custom" ? "custom" : networkSel.value;
      const networkOpt = netType === "custom"
        ? { type: "custom", name: "Custom", rpcUrl: rpc }
        : { type: netType };
      await wallet.requestPermissions({ network: networkOpt });
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
      const parser = new michelCodec_20.Parser();
      const contractCode = parser.parseScript(code);

      const tokenInfo = new taquito_20.MichelsonMap();
      tokenInfo.set("name", toHexBytes(name));
      tokenInfo.set("symbol", toHexBytes(symbol));

      const tokenMetadata = new taquito_20.MichelsonMap();
      tokenMetadata.set(0, { token_id: 0, token_info: tokenInfo });

      const storage = {
        ledger: new taquito_20.MichelsonMap(),
        operators: new taquito_20.MichelsonMap(),
        token_ids: [0],
        token_metadata: tokenMetadata,
        token_supply: new taquito_20.MichelsonMap(),
        extension: {
          admin: userAddress,
          token_usage: new taquito_20.MichelsonMap(),
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

}));
//# sourceMappingURL=deployment-ft.umd.js.map
