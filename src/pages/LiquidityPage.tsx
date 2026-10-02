import { useMemo, useState } from "react";
import { NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { fetchTokenMetadata } from "../shared/tokenMetadata";
import { isValidAddress, useWallet } from "../shared/tezos";
import { formatUnits, parseUnits, toBigInt } from "../shared/units";

type Pool = {
  address: string;
  contract: any;
  sharesMap: any;
  tokenAddress: string;
  tokenId: string;
  xtzPool: bigint;
  tokenPool: bigint;
  totalShares: bigint;
  token: { symbol: string; decimals: number };
  initialized: boolean;
};

type AddQuote = { xtzIn: bigint; tokenIn: bigint; shares: bigint; minShares: bigint };
type RemoveQuote = { shares: bigint; xtzOut: bigint; tokenOut: bigint; minXtz: bigint; minToken: bigint };

function PoolInfo({ pool }: { pool: Pool | null }) {
  if (!pool) return null;
  return <div className="info">
    {`Reserves: ${formatUnits(pool.xtzPool, 6)} XTZ / ${formatUnits(pool.tokenPool, pool.token.decimals)} ${pool.token.symbol}\n`}
    {`Total shares: ${pool.totalShares}`}
  </div>;
}

function calculateAddQuote(pool: Pool | null, value: string, slippage: string): AddQuote | null {
  if (!pool || !pool.initialized) return null;
  const xtzIn = parseUnits(value, 6);
  const slippageBps = Math.round(Number(slippage) * 100);
  if (!xtzIn || xtzIn <= 0n || slippageBps < 0 || slippageBps > 5000) return null;

  const tokenIn = (pool.tokenPool * xtzIn) / pool.xtzPool;
  const shares = (pool.totalShares * xtzIn) / pool.xtzPool;
  return { xtzIn, tokenIn, shares, minShares: (shares * BigInt(10000 - slippageBps)) / 10000n };
}

function calculateRemoveQuote(pool: Pool | null, value: string, slippage: string): RemoveQuote | null {
  if (!pool || !pool.initialized || !/^\d+$/.test(value)) return null;
  const shares = BigInt(value);
  const slippageBps = Math.round(Number(slippage) * 100);
  if (shares <= 0n || slippageBps < 0 || slippageBps > 5000) return null;

  const xtzOut = (pool.xtzPool * shares) / pool.totalShares;
  const tokenOut = (pool.tokenPool * shares) / pool.totalShares;
  return {
    shares,
    xtzOut,
    tokenOut,
    minXtz: (xtzOut * BigInt(10000 - slippageBps)) / 10000n,
    minToken: (tokenOut * BigInt(10000 - slippageBps)) / 10000n,
  };
}

export function LiquidityPage() {
  const wallet = useWallet("BRO Builder Liquidity");
  const [address, setAddress] = useState("");
  const [pool, setPool] = useState<Pool | null>(null);
  const [myShares, setMyShares] = useState(0n);
  const [addXtz, setAddXtz] = useState("");
  const [removeShares, setRemoveShares] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [messages, setMessages] = useState(["Idle."]);

  const addQuote = useMemo(() => calculateAddQuote(pool, addXtz, slippage), [pool, addXtz, slippage]);
  const removeQuote = useMemo(() => calculateRemoveQuote(pool, removeShares, slippage), [pool, removeShares, slippage]);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function refreshShares(loadedPool: Pool) {
    if (!wallet.address) {
      setMyShares(0n);
      return;
    }
    const value = await loadedPool.sharesMap.get(wallet.address);
    setMyShares(value ? toBigInt(value) : 0n);
  }

  async function loadPool() {
    if (!isValidAddress(address)) {
      log("Enter a valid DEX contract address (KT1...).");
      return;
    }

    try {
      const { toolkit } = await wallet.ensureWallet();
      const contract: any = await toolkit.wallet.at(address);
      const storage: any = await contract.storage();
      const tokenId = storage.token_id.toString();
      const token = await fetchTokenMetadata(
        wallet.selected.api,
        storage.token_address,
        tokenId,
      );
      const loadedPool: Pool = {
        address,
        contract,
        sharesMap: storage.shares,
        tokenAddress: storage.token_address,
        tokenId,
        xtzPool: toBigInt(storage.xtz_pool),
        tokenPool: toBigInt(storage.token_pool),
        totalShares: toBigInt(storage.total_shares),
        token,
        initialized: !storage.total_shares.isZero(),
      };

      setPool(loadedPool);
      await refreshShares(loadedPool);
      log("Pool loaded.");
    } catch (error) {
      log(`Failed to load pool: ${getErrorMessage(error)}`);
    }
  }

  function setPercentage(percentage: number) {
    setRemoveShares(((myShares * BigInt(percentage)) / 100n).toString());
  }

  async function addLiquidity() {
    if (!pool || !addQuote || !wallet.address) return;

    try {
      const operation = await pool.contract.methodsObject.add_liquidity(addQuote.minShares.toString()).send({
        amount: Number(addQuote.xtzIn),
        mutez: true,
      });
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log("Liquidity added.");
    } catch (error) {
      log(`Add liquidity failed: ${getErrorMessage(error)}`);
    }
  }

  async function removeLiquidity() {
    if (!pool || !removeQuote || !wallet.address) return;

    try {
      const operation = await pool.contract.methodsObject.remove_liquidity({
        shares: removeQuote.shares.toString(),
        min_xtz: removeQuote.minXtz.toString(),
        min_token: removeQuote.minToken.toString(),
      }).send();
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log("Liquidity removed.");
    } catch (error) {
      log(`Remove liquidity failed: ${getErrorMessage(error)}`);
    }
  }

  return <Page title="Manage Liquidity" subtitle="Add liquidity to a DEX pool to earn its swap fees, or withdraw your share at any time.">
    <NetworkWallet wallet={wallet} />
    <Section title="3. DEX Pool">
      <label>DEX contract address
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <button className="secondary" onClick={() => void loadPool()}>Load Pool</button>
      <PoolInfo pool={pool} />
    </Section>
    <Section title="4. Slippage">
      <label>Slippage tolerance (%)
        <input type="number" value={slippage} onChange={(event) => setSlippage(event.target.value)} min="0" max="50" step="0.1" />
      </label>
    </Section>
    <Section title="5. Add Liquidity">
      <label>XTZ to deposit
        <input value={addXtz} onChange={(event) => setAddXtz(event.target.value)} disabled={!pool?.initialized} placeholder="0.0" />
      </label>
      <div className="info">{addQuote ? `You will deposit: ${formatUnits(addQuote.tokenIn, pool?.token.decimals ?? 0)} ${pool?.token.symbol}\nYou will receive: ${addQuote.shares} shares (minimum ${addQuote.minShares})` : ""}</div>
      <button disabled={!addQuote || !wallet.address} onClick={() => void addLiquidity()}>Add Liquidity</button>
    </Section>
    <Section title="6. Remove Liquidity">
      <label>Shares to redeem
        <input value={removeShares} onChange={(event) => setRemoveShares(event.target.value)} disabled={!pool?.initialized} placeholder="0" />
      </label>
      <div className="row">
        {[25, 50, 75, 100].map((percentage) => <button key={percentage} className="secondary small" disabled={!pool || myShares === 0n} onClick={() => setPercentage(percentage)}>{percentage === 100 ? "Max" : `${percentage}%`}</button>)}
      </div>
      <div className="info">{removeQuote ? `You will receive: ${formatUnits(removeQuote.xtzOut, 6)} XTZ + ${formatUnits(removeQuote.tokenOut, pool?.token.decimals ?? 0)} ${pool?.token.symbol}\nMinimum: ${formatUnits(removeQuote.minXtz, 6)} XTZ + ${formatUnits(removeQuote.minToken, pool?.token.decimals ?? 0)} ${pool?.token.symbol}` : ""}</div>
      <button disabled={!removeQuote || !wallet.address} onClick={() => void removeLiquidity()}>Remove Liquidity</button>
    </Section>
    <Status messages={messages} />
  </Page>;
}
