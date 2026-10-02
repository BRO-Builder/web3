import { useState } from "react";
import { NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { isValidAddress, useWallet } from "../shared/tezos";

 type Dex = {
  address: string;
  contract: any;
  tokenAddress: string;
  tokenId: string;
  initialized: boolean;
};

function DexInfo({ dex }: { dex: Dex | null }) {
  if (!dex) return null;
  return <div className="info">
    {`Token contract: ${dex.tokenAddress}\nToken ID: ${dex.tokenId}\nPool: ${dex.initialized ? "already initialized" : "not initialized"}`}
  </div>;
}

export function SetupPage() {
  const wallet = useWallet("BRO Builder DEX Setup");
  const [address, setAddress] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [xtzAmount, setXtzAmount] = useState("");
  const [dex, setDex] = useState<Dex | null>(null);
  const [messages, setMessages] = useState(["Idle."]);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function loadDex() {
    if (!isValidAddress(address)) {
      log("Enter a valid DEX contract address (KT1...).");
      return;
    }

    try {
      const { toolkit } = await wallet.ensureWallet();
      log("Reading DEX storage...");
      const contract: any = await toolkit.wallet.at(address);
      const storage: any = await contract.storage();
      setDex({
        address,
        contract,
        tokenAddress: storage.token_address,
        tokenId: storage.token_id.toString(),
        initialized: !storage.total_shares.isZero(),
      });
    } catch (error) {
      log(`Failed to load DEX: ${getErrorMessage(error)}`);
    }
  }

  async function authorizeDex() {
    if (!dex || !wallet.address) return;

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
    }
  }

  async function initializePool() {
    if (!dex || !wallet.address) return;
    if (!/^[1-9]\d*$/.test(tokenAmount) || !(Number(xtzAmount) > 0)) {
      log("Enter a positive token amount and XTZ amount.");
      return;
    }

    try {
      await wallet.ensureWallet();
      log(`Initializing pool with ${tokenAmount} tokens and ${xtzAmount} XTZ...`);
      const operation = await dex.contract.methodsObject.initialize_pool(tokenAmount).send({ amount: xtzAmount });
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      setDex((current) => current ? { ...current, initialized: true } : current);
      log(`Pool initialized. ${wallet.selected.explorer}/${dex.address}`);
    } catch (error) {
      log(`initialize_pool failed: ${getErrorMessage(error)}`);
      log("Check that you ran the Authorize step and hold enough tokens.");
    }
  }

  return <Page title="Set Up DEX Pool" subtitle="Authorize the DEX on your token, then seed the pool with the first liquidity.">
    <NetworkWallet wallet={wallet} />
    <Section title="3. DEX Contract">
      <label>DEX contract address
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <button className="secondary" onClick={() => void loadDex()}>Load DEX</button>
      <DexInfo dex={dex} />
    </Section>
    <Section title="4. Authorize DEX (update_operators)">
      <p className="hint">Lets the DEX pull your tokens from your wallet for this pool.</p>
      <button disabled={!dex || !wallet.address} onClick={() => void authorizeDex()}>Authorize DEX</button>
    </Section>
    <Section title="5. Initialize Pool">
      <label>Token amount (raw units)
        <input type="number" value={tokenAmount} onChange={(event) => setTokenAmount(event.target.value)} min="1" />
      </label>
      <label>XTZ amount
        <input type="number" value={xtzAmount} onChange={(event) => setXtzAmount(event.target.value)} min="0" step="any" />
      </label>
      <button disabled={!dex || dex.initialized || !wallet.address} onClick={() => void initializePool()}>Initialize Pool</button>
    </Section>
    <Status messages={messages} />
  </Page>;
}
