import { useEffect, useState } from "react";
import { LoadingButton, NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { fetchTokenMetadata } from "../shared/tokenMetadata";
import { isValidAddress, useWallet } from "../shared/tezos";
import { formatUnits, parseUnits, toBigInt } from "../shared/units";

type TokenInfo = { symbol: string; decimals: number };
type Pool = {
  address: string;
  contract: any;
  token: TokenInfo;
  tokenAddress: string;
  tokenId: string;
  xtzPool: bigint;
  tokenPool: bigint;
  initialized: boolean;
};
type Quote = { amountIn: bigint; out: bigint; minOut: bigint };

function PoolDetails({ pool }: { pool: Pool | null }) {
  if (!pool) return null;
  return <div className="info">
    {`Token: ${pool.token.symbol} (${pool.tokenAddress}, id ${pool.tokenId})\n`}
    {`Reserves: ${formatUnits(pool.xtzPool, 6)} XTZ / ${formatUnits(pool.tokenPool, pool.token.decimals)} ${pool.token.symbol}`}
  </div>;
}

export function ExchangePage() {
  const wallet = useWallet();
  const [address, setAddress] = useState("");
  const [pool, setPool] = useState<Pool | null>(null);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [reverse, setReverse] = useState(false);
  const [authorizeOperator, setAuthorizeOperator] = useState(true);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [messages, setMessages] = useState(["Idle."]);
  const [swapping, setSwapping] = useState(false);
  const [loadingPool, setLoadingPool] = useState(false);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function loadPool() {
    if (!isValidAddress(address)) {
      log("Enter a valid DEX contract address (KT1...).");
      return;
    }

    setLoadingPool(true);
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
        token,
        tokenAddress: storage.token_address,
        tokenId,
        xtzPool: toBigInt(storage.xtz_pool),
        tokenPool: toBigInt(storage.token_pool),
        initialized: !storage.total_shares.isZero(),
      };

      setPool(loadedPool);
      setAmount("");
      setQuote(null);
      log("Pool loaded.");
    } catch (error) {
      log(`Failed to load pool: ${getErrorMessage(error)}`);
    } finally {
      setLoadingPool(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function fetchQuote() {
      if (!pool?.initialized || !amount) {
        setQuote(null);
        return;
      }

      const inputDecimals = reverse ? pool.token.decimals : 6;
      const amountIn = parseUnits(amount, inputDecimals);
      if (!amountIn || amountIn <= 0n) {
        setQuote(null);
        return;
      }

      try {
        const view = reverse
          ? pool.contract.contractViews.get_price_token_to_xtz(amountIn.toString())
          : pool.contract.contractViews.get_price_xtz_to_token(amountIn.toString());
        const output = toBigInt(await view.executeView({ viewCaller: wallet.address || pool.address }));
        const minimumOutput = (output * BigInt(10000 - Math.round(Number(slippage) * 100))) / 10000n;

        if (!cancelled) {
          setQuote({ amountIn, out: output, minOut: minimumOutput });
        }
      } catch {
        if (!cancelled) setQuote(null);
      }
    }

    void fetchQuote();
    return () => { cancelled = true; };
  }, [amount, pool, reverse, slippage, wallet.address]);

  async function swap() {
    if (!quote || !pool || !wallet.address) return;

    setSwapping(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      let operation;

      if (reverse) {
        const swapCall = pool.contract.methodsObject.token_to_xtz({
          token_amount: quote.amountIn.toString(),
          min_xtz_out: quote.minOut.toString(),
        });

        if (authorizeOperator) {
          const token: any = await toolkit.wallet.at(pool.tokenAddress);
          const authorizeCall = token.methodsObject.update_operators([{
            add_operator: {
              owner: wallet.address,
              operator: pool.address,
              token_id: pool.tokenId,
            },
          }]);
          operation = await toolkit.wallet.batch()
            .withContractCall(authorizeCall)
            .withContractCall(swapCall)
            .send();
        } else {
          operation = await swapCall.send();
        }
      } else {
        operation = await pool.contract.methodsObject.xtz_to_token(quote.minOut.toString()).send({
          amount: Number(quote.amountIn),
          mutez: true,
        });
      }

      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log(`Swap complete. ${wallet.selected.explorer}/${operation.opHash}`);
      setAmount("");
      setQuote(null);
    } catch (error) {
      log(`Swap failed: ${getErrorMessage(error)}`);
    } finally {
      setSwapping(false);
    }
  }

  const inputSymbol = reverse ? pool?.token.symbol ?? "TOKEN" : "XTZ";
  const outputSymbol = reverse ? "XTZ" : pool?.token.symbol ?? "TOKEN";
  const outputDecimals = reverse ? 6 : pool?.token.decimals ?? 0;

  return <Page title="Token <-> XTZ Exchange" subtitle="Swap XTZ and an FA2 token against a constant-product DEX pool.">
    <NetworkWallet wallet={wallet} />
    <Section title="3. DEX Pool">
      <label>DEX contract address
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <LoadingButton className="secondary" loading={loadingPool} onClick={() => void loadPool()}>Load Pool</LoadingButton>
      <PoolDetails pool={pool} />
    </Section>
    <Section title="4. Swap">
      <label>You pay ({inputSymbol})
        <input value={amount} onChange={(event) => setAmount(event.target.value)} disabled={!pool?.initialized} placeholder="0.0" autoComplete="off" />
      </label>
      <button className="secondary" disabled={!pool?.initialized} onClick={() => { setReverse((current) => !current); setAmount(""); setQuote(null); }}>
        ↕ Flip direction
      </button>
      <label>You receive, estimated ({outputSymbol})
        <input readOnly value={quote ? formatUnits(quote.out, outputDecimals) : ""} placeholder="0.0" />
      </label>
      <label>Slippage tolerance (%)
        <input type="number" value={slippage} onChange={(event) => setSlippage(event.target.value)} min="0" max="50" step="0.1" />
      </label>
      <div className="info">{quote ? `Minimum received: ${formatUnits(quote.minOut, outputDecimals)} ${outputSymbol}` : ""}</div>
      {reverse && <>
        <label style={{ display: "flex", gap: "8px", alignItems: "center", fontWeight: 500 }}>
          <input type="checkbox" checked={authorizeOperator} onChange={(event) => setAuthorizeOperator(event.target.checked)} style={{ width: "auto" }} />
          Authorize the DEX as operator in the same transaction
        </label>
        <p className="hint">Required once so the DEX can pull your tokens. Untick it if you already authorized it.</p>
      </>}
      <LoadingButton className="deploy" loading={swapping} disabled={!quote || !wallet.address} onClick={() => void swap()}>Swap</LoadingButton>
    </Section>
    <Status messages={messages} />
  </Page>;
}
