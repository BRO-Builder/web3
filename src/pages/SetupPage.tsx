import { useState } from "react";
import { LoadingButton, NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { fetchTokenMetadata, type TokenMetadata } from "../shared/tokenMetadata";
import { parseUnits } from "../shared/units";
import { isValidAddress, useWallet } from "../shared/tezos";

 type Dex = {
  address: string;
  contract: any;
  tokenAddress: string;
  tokenId: string;
  token: TokenMetadata;
  initialized: boolean;
  vaultAddress: string;
};

function DexInfo({ dex }: { dex: Dex | null }) {
  if (!dex) return null;
  return <div className="info">
    {`Token: ${dex.token.symbol} (${dex.tokenAddress}, id ${dex.tokenId})\nVault: ${dex.vaultAddress}\nPool: ${dex.initialized ? "already initialized" : "not initialized"}`}
  </div>;
}

export function SetupPage() {
  const wallet = useWallet();
  const [address, setAddress] = useState("");
  const [vaultAddress, setVaultAddress] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [xtzAmount, setXtzAmount] = useState("");
  const [dex, setDex] = useState<Dex | null>(null);
  const [vaultLinked, setVaultLinked] = useState(false);
  const [linkingVault, setLinkingVault] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [loadingDex, setLoadingDex] = useState(false);
  const [messages, setMessages] = useState(["Idle."]);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function loadDex() {
    if (!isValidAddress(address)) {
      log("Enter a valid DEX contract address (KT1...).");
      return;
    }

    setLoadingDex(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      log("Reading DEX storage...");
      const contract = await toolkit.wallet.at(address);
      const storage: any = await contract.storage();
      const vault: any = await toolkit.wallet.at(storage.vault);
      const vaultStorage: any = await vault.storage();
      const tokenId = storage.token_id.toString();
      const token = await fetchTokenMetadata(
        wallet.selected.api,
        storage.token_address,
        tokenId,
      );
      setDex({
        address,
        contract,
        tokenAddress: storage.token_address,
        tokenId,
        token,
        initialized: !storage.total_shares.isZero(),
        vaultAddress: storage.vault,
      });
      setVaultAddress(storage.vault);
      setVaultLinked(vaultStorage.dex !== null && vaultStorage.dex !== undefined);
    } catch (error) {
      console.error(error);
      log(`Failed to load DEX: ${getErrorMessage(error)}`);
    } finally {
      setLoadingDex(false);
    }
  }

  async function linkVault() {
    if (!dex || !wallet.address) return;
    if (!isValidAddress(vaultAddress)) {
      log("Enter a valid BRODelegator vault contract address.");
      return;
    }

    setLinkingVault(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const vault: any = await toolkit.wallet.at(vaultAddress);
      const operation = await vault.methodsObject.set_dex(dex.address).send();
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      setVaultLinked(true);
      log(`Done. The vault is now linked to ${dex.address}.`);
    } catch (error) {
      log(`set_dex failed: ${getErrorMessage(error)}`);
      log("This link can only be set once, and must be sent by the vault admin.");
    } finally {
      setLinkingVault(false);
    }
  }

  async function authorizeDex() {
    if (!dex || !wallet.address) return;

    setAuthorizing(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const token: any = await toolkit.wallet.at(dex.tokenAddress);
      const operation = await token.methodsObject.update_operators([{
        add_operator: {
          owner: wallet.address,
          operator: dex.address,
          token_id: dex.tokenId,
        },
      }]).send();

      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log(`Done. The DEX is now an operator of ${wallet.address}.`);
    } catch (error) {
      log(`update_operators failed: ${getErrorMessage(error)}`);
    } finally {
      setAuthorizing(false);
    }
  }

  async function initializePool() {
    if (!dex || !wallet.address) return;
    const tokenAmountInUnits = parseUnits(tokenAmount, dex.token.decimals);
    if (!tokenAmountInUnits || tokenAmountInUnits <= 0n || !(Number(xtzAmount) > 0)) {
      log(`Enter a positive ${dex.token.symbol} amount with at most ${dex.token.decimals} decimals and a positive XTZ amount.`);
      return;
    }

    setInitializing(true);
    try {
      await wallet.ensureWallet();
      log(`Initializing pool with ${tokenAmount} ${dex.token.symbol} and ${xtzAmount} XTZ...`);
      const operation = await dex.contract.methodsObject.initialize_pool(tokenAmountInUnits.toString()).send({ amount: xtzAmount });
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      setDex((current) => current ? { ...current, initialized: true } : current);
      log(`Pool initialized. ${wallet.selected.explorer}/${dex.address}`);
    } catch (error) {
      log(`initialize_pool failed: ${getErrorMessage(error)}`);
      log("Check that you ran the Authorize step and hold enough tokens.");
    } finally {
      setInitializing(false);
    }
  }

  return <Page title="Set Up DEX Pool" subtitle="Authorize the DEX on your token, then seed the pool with the first liquidity.">
    <NetworkWallet wallet={wallet} />
    <Section title="3. DEX Contract">
      <label>DEX contract address
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <LoadingButton className="secondary" loading={loadingDex} onClick={() => void loadDex()}>Load DEX</LoadingButton>
      <DexInfo dex={dex} />
    </Section>
    <Section title="4. Link Delegator Vault (set_dex)">
      <label>Delegator vault address
        <input value={vaultAddress} onChange={(event) => setVaultAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <p className="hint">The vault address is read from the DEX storage when you load it. Send this one-time call as the vault admin.</p>
      <LoadingButton loading={linkingVault} disabled={!dex || !wallet.address || vaultLinked} onClick={() => void linkVault()}>
        {vaultLinked ? "Vault Linked" : "Link Vault to DEX"}
      </LoadingButton>
    </Section>
    <Section title="5. Authorize DEX (update_operators)">
      <p className="hint">Lets the DEX pull your tokens. Calls <code>update_operators</code> on the token contract, adding the DEX as an operator of your wallet for the DEX's token ID.</p>
      <LoadingButton loading={authorizing} disabled={!dex || !wallet.address} onClick={() => void authorizeDex()}>Authorize DEX</LoadingButton>
    </Section>
    <Section title="6. Initialize Pool">
      <label>Token amount ({dex?.token.symbol ?? "token"})
        <input type="number" value={tokenAmount} onChange={(event) => setTokenAmount(event.target.value)} min="0" step="any" />
      </label>
      <p className="hint">Enter the token amount using its displayed decimals. Your wallet must hold at least this much.</p>
      <label>XTZ amount
        <input type="number" value={xtzAmount} onChange={(event) => setXtzAmount(event.target.value)} min="0" step="any" />
      </label>
      <p className="hint">Sent with the call. The opening price is XTZ divided by tokens, and you receive shares equal to the token amount. This can only be done once.</p>
      <LoadingButton loading={initializing} disabled={!dex || dex.initialized || !wallet.address} onClick={() => void initializePool()}>Initialize Pool</LoadingButton>
    </Section>
    <Status messages={messages} />
  </Page>;
}
