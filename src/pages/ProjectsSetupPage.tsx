import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LoadingButton, NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { fetchTokenMetadata, type TokenMetadata } from "../shared/tokenMetadata";
import { formatUnits, parseUnits, toBigInt } from "../shared/units";
import { isValidAddress, useWallet } from "../shared/tezos";
import { fetchTokenBalance, isPriceStale, priceFromUsd, readOption, usdFromPrice } from "../shared/broProjects";

type ContractKey = "funding" | "projects" | "market";

type Setup = {
  funding: string;
  projects: string;
  market: string;
  admins: Record<ContractKey, string>;
  fundingPaused: boolean;
  projectsPaused: boolean;
  fundingProjects: string | null;
  fundingMarket: string;
  projectsFunding: string;
  projectsMarket: string;
  marketLedger: string | null;
  oracle: string;
  tokens: Record<ContractKey, string>;
  tokenAddress: string;
  tokenId: string;
  token: TokenMetadata;
  lateFeeBpsPerDay: bigint;
  graceDays: bigint;
  nft: { address: string; tokenId: string } | null;
  price: bigint;
  priceUpdatedAt: string;
  maxPriceAge: bigint;
  reserveBro: bigint | null;
  reserveXtz: bigint;
  walletBro: bigint | null;
};

const CONTRACT_NAMES: Record<ContractKey, string> = {
  funding: "BROFunding",
  projects: "BROProjects",
  market: "BROMarketAssistant",
};

function Check({ ok, optional, children }: { ok: boolean; optional?: boolean; children: string }) {
  return <li>
    <span className={`tag ${ok ? "ok" : optional ? "" : "warn"}`}>{ok ? "done" : optional ? "optional" : "to do"}</span> {children}
  </li>;
}

function Step({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="action">
    <h4>{title}</h4>
    {hint && <p className="hint">{hint}</p>}
    {children}
  </div>;
}

export function ProjectsSetupPage() {
  const wallet = useWallet();
  const [fundingAddress, setFundingAddress] = useState("");
  const [projectsAddress, setProjectsAddress] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [broAmount, setBroAmount] = useState("");
  const [xtzAmount, setXtzAmount] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [nftAddress, setNftAddress] = useState("");
  const [nftTokenId, setNftTokenId] = useState("0");
  const [lateFee, setLateFee] = useState("");
  const [graceDays, setGraceDays] = useState("");
  const [maxPriceAge, setMaxPriceAge] = useState("");
  const [newMarket, setNewMarket] = useState("");
  const [newAdmins, setNewAdmins] = useState<Record<ContractKey, string>>({ funding: "", projects: "", market: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState(["Idle."]);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function load() {
    const funding = fundingAddress.trim();
    const projects = projectsAddress.trim();
    if (!isValidAddress(funding) || !isValidAddress(projects)) {
      log("Enter valid BROFunding and BROProjects contract addresses (KT1...).");
      return;
    }

    setBusy((current) => current ?? "load");
    try {
      const { toolkit } = await wallet.ensureWallet();
      log("Reading BROFunding, BROProjects and market storage...");
      const [fundingStorage, projectsStorage]: any[] = await Promise.all([
        toolkit.wallet.at(funding).then((contract) => contract.storage()),
        toolkit.wallet.at(projects).then((contract) => contract.storage()),
      ]);
      const market: string = fundingStorage.market;
      const marketStorage: any = await (await toolkit.wallet.at(market)).storage();
      const tokenAddress: string = fundingStorage.token_address;
      const tokenId = fundingStorage.token_id.toString();

      let token: TokenMetadata;
      try {
        token = await fetchTokenMetadata(wallet.selected.api, tokenAddress, tokenId);
      } catch (error) {
        log(`Token metadata unavailable (${getErrorMessage(error)}). Showing raw base units.`);
        token = { symbol: "BRO", decimals: 0 };
      }

      const nft = readOption<any>(projectsStorage.nft);
      const next: Setup = {
        funding,
        projects,
        market,
        admins: { funding: fundingStorage.admin, projects: projectsStorage.admin, market: marketStorage.admin },
        fundingPaused: Boolean(fundingStorage.paused),
        projectsPaused: Boolean(projectsStorage.paused),
        fundingProjects: readOption<string>(fundingStorage.projects_contract),
        fundingMarket: market,
        projectsFunding: projectsStorage.funding,
        projectsMarket: projectsStorage.market,
        marketLedger: readOption<string>(marketStorage.ledger),
        oracle: marketStorage.oracle,
        tokens: {
          funding: `${tokenAddress}#${tokenId}`,
          projects: `${projectsStorage.token_address}#${projectsStorage.token_id}`,
          market: `${marketStorage.token_address}#${marketStorage.token_id}`,
        },
        tokenAddress,
        tokenId,
        token,
        lateFeeBpsPerDay: toBigInt(fundingStorage.late_fee_bps_per_day),
        graceDays: toBigInt(projectsStorage.grace_days),
        nft: nft ? { address: nft.address, tokenId: nft.token_id.toString() } : null,
        price: toBigInt(marketStorage.price),
        priceUpdatedAt: marketStorage.price_updated_at,
        maxPriceAge: toBigInt(marketStorage.max_price_age),
        reserveBro: await fetchTokenBalance(wallet.selected.api, market, tokenAddress, tokenId),
        reserveXtz: toBigInt(await toolkit.tz.getBalance(market)),
        walletBro: wallet.address ? await fetchTokenBalance(wallet.selected.api, wallet.address, tokenAddress, tokenId) : null,
      };
      setSetup(next);
      setLateFee(next.lateFeeBpsPerDay.toString());
      setGraceDays(next.graceDays.toString());
      setMaxPriceAge(next.maxPriceAge.toString());
      if (next.nft) {
        setNftAddress(next.nft.address);
        setNftTokenId(next.nft.tokenId);
      }
      log("Contracts loaded.");
    } catch (error) {
      console.error(error);
      log(`Failed to load: ${getErrorMessage(error)}`);
    } finally {
      setBusy((current) => current === "load" ? null : current);
    }
  }

  // Sends one operation and reloads all three contracts afterwards.
  async function run(key: string, label: string, build: (toolkit: any, setup: Setup) => Promise<any>) {
    if (!wallet.address || !setup) {
      log("Connect a wallet and load the contracts first.");
      return;
    }
    setBusy(key);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const operation = await build(toolkit, setup);
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log(`${label} complete.`);
      await load();
    } catch (error) {
      log(`${label} failed: ${getErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function call(toolkit: any, address: string, entrypoint: string, argument: unknown) {
    const contract: any = await toolkit.wallet.at(address);
    return contract.methodsObject[entrypoint](argument).send();
  }

  function fundBro() {
    if (!setup) return;
    const amount = parseUnits(broAmount, setup.token.decimals);
    if (!amount || amount <= 0n) {
      log(`Enter a positive ${setup.token.symbol} amount with at most ${setup.token.decimals} decimals.`);
      return;
    }
    void run("bro", "BRO reserve transfer", (toolkit, s) => call(toolkit, s.tokenAddress, "transfer", [{
      from_: wallet.address,
      txs: [{ to_: s.market, token_id: s.tokenId, amount: amount.toString() }],
    }]));
  }

  function fundXtz() {
    if (!(Number(xtzAmount) > 0)) {
      log("Enter a positive XTZ amount.");
      return;
    }
    void run("xtz", "XTZ reserve transfer", (toolkit, s) => toolkit.wallet.transfer({ to: s.market, amount: Number(xtzAmount) }).send());
  }

  function pushPrice() {
    if (!setup) return;
    const price = priceFromUsd(priceInput, setup.token.decimals);
    if (!price || price <= 0n) {
      log(`Enter a positive USD price for 1 ${setup.token.symbol} (up to 8 decimals).`);
      return;
    }
    log(`Pushing price: ${price} (BRO base units per cent x 10^6).`);
    void run("price", "update_price", (toolkit, s) => call(toolkit, s.market, "update_price", price.toString()));
  }

  function setNft(clear: boolean) {
    if (!clear && (!isValidAddress(nftAddress.trim()) || !/^\d+$/.test(nftTokenId))) {
      log("Enter a valid NFT contract address and token ID.");
      return;
    }
    const value = clear ? null : { address: nftAddress.trim(), token_id: nftTokenId };
    void run(clear ? "nft-clear" : "nft", "set_nft", (toolkit, s) => call(toolkit, s.projects, "set_nft", value));
  }

  function setNumber(key: string, entrypoint: string, value: string, valid: (n: number) => boolean, error: string, target: ContractKey) {
    const n = Number(value);
    if (!Number.isInteger(n) || !valid(n)) {
      log(error);
      return;
    }
    void run(key, entrypoint, (toolkit, s) => call(toolkit, s[target], entrypoint, n.toString()));
  }

  function changeMarket(target: "funding" | "projects") {
    const address = newMarket.trim();
    if (!isValidAddress(address)) {
      log("Enter a valid BROMarketAssistant contract address.");
      return;
    }
    void run(`market-${target}`, `${CONTRACT_NAMES[target]} set_market`, (toolkit, s) => call(toolkit, s[target], "set_market", address));
  }

  function transferAdmin(target: ContractKey) {
    const address = newAdmins[target].trim();
    if (!isValidAddress(address)) {
      log(`Enter a valid new admin address for ${CONTRACT_NAMES[target]}.`);
      return;
    }
    void run(`admin-${target}`, `${CONTRACT_NAMES[target]} set_admin`, (toolkit, s) => call(toolkit, s[target], "set_admin", address));
  }

  const s = setup;
  const symbol = s?.token.symbol ?? "BRO";
  const formatBro = (units: bigint | null) => units === null ? "unknown" : `${formatUnits(units, s?.token.decimals ?? 0)} ${symbol}`;
  const isAdmin = (key: ContractKey) => Boolean(s && wallet.address === s.admins[key]);
  const isOracle = Boolean(s && wallet.address === s.oracle);
  const tokensMatch = Boolean(s && s.tokens.funding === s.tokens.projects && s.tokens.funding === s.tokens.market);
  const marketsMatch = Boolean(s && s.fundingMarket === s.projectsMarket);
  const projectsKnowsFunding = Boolean(s && s.projectsFunding === s.funding);
  const fundingLinked = Boolean(s && s.fundingProjects === s.projects);
  const fundingLinkedElsewhere = Boolean(s && s.fundingProjects && s.fundingProjects !== s.projects);
  const marketLinked = Boolean(s && s.marketLedger === s.projects);
  const reserveFunded = Boolean(s?.reserveBro && s.reserveBro > 0n);
  const priceFresh = Boolean(s && !isPriceStale(s.price, s.priceUpdatedAt, s.maxPriceAge));
  const ready = tokensMatch && marketsMatch && projectsKnowsFunding && fundingLinked && marketLinked && reserveFunded && priceFresh;

  function adminTag(key: ContractKey) {
    return isAdmin(key) ? "  (you)" : "";
  }

  return <Page title="Set Up BRO Projects" subtitle="Link BROFunding, BROProjects and the market assistant, fund the reserve, push the first price, and manage the admin settings of all three.">
    <NetworkWallet wallet={wallet} />

    <Section title="3. Contracts">
      <label>BROFunding contract address
        <input value={fundingAddress} onChange={(event) => setFundingAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <label>BROProjects contract address
        <input value={projectsAddress} onChange={(event) => setProjectsAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <p className="hint">The market assistant address is read from BROFunding's storage.</p>
      <LoadingButton className="secondary" loading={busy === "load"} onClick={() => void load()}>{s ? "Reload" : "Load Contracts"}</LoadingButton>
      {s && <>
        <div className="info">
          {[
            `BROFunding: ${s.funding}${s.fundingPaused ? "  (PAUSED)" : ""}`,
            `  admin: ${s.admins.funding}${adminTag("funding")}`,
            `BROProjects: ${s.projects}${s.projectsPaused ? "  (PAUSED)" : ""}`,
            `  admin: ${s.admins.projects}${adminTag("projects")}`,
            `Market: ${s.market}`,
            `  admin: ${s.admins.market}${adminTag("market")}`,
            `  oracle: ${s.oracle}${isOracle ? "  (you)" : ""}`,
            `Token: ${symbol} (${s.tokenAddress}, id ${s.tokenId})`,
          ].join("\n")}
        </div>
        <h4>Checklist</h4>
        <ul className="checklist">
          <Check ok={tokensMatch}>{tokensMatch
            ? "All three contracts use the same token"
            : `Token mismatch (funding ${s.tokens.funding}, projects ${s.tokens.projects}, market ${s.tokens.market}); redeploy the odd one out`}</Check>
          <Check ok={projectsKnowsFunding}>{projectsKnowsFunding
            ? "BROProjects was deployed with this BROFunding"
            : `BROProjects expects funding ${s.projectsFunding}; redeploy BROProjects with this BROFunding address`}</Check>
          <Check ok={marketsMatch}>{marketsMatch ? "BROFunding and BROProjects use the same market" : `Market mismatch: BROProjects uses ${s.projectsMarket}`}</Check>
          <Check ok={fundingLinked}>{fundingLinkedElsewhere
            ? `BROFunding is linked to a different BROProjects (${s.fundingProjects}); this link cannot be changed`
            : "BROFunding linked to BROProjects (set_projects)"}</Check>
          <Check ok={marketLinked}>Market linked to BROProjects (set_ledger)</Check>
          <Check ok={reserveFunded}>{`BRO reserve funded (${formatBro(s.reserveBro)})`}</Check>
          <Check ok={priceFresh}>{s.price > 0n ? `Price is fresh ($${usdFromPrice(s.price, s.token.decimals)} per ${symbol})` : "First price pushed"}</Check>
          <Check ok={Boolean(s.nft)} optional>Approver NFT set (otherwise only the BROProjects admin approves milestones)</Check>
        </ul>
        {ready && <div className="note">
          <strong>Ready.</strong> Contractors and investors can now use the <Link to="/projects">projects page</Link>.
        </div>}
      </>}
    </Section>

    {s && <>
      <Section title="4. Link the Contracts">
        <Step title="BROFunding → BROProjects (set_projects)" hint={<>BROFunding admin only. <strong>One-time and irreversible.</strong> Lets funding hand fully funded projects and their BRO to BROProjects; until then, the deposit that completes funding fails.</>}>
          <div className="info">{`BROFunding currently linked to: ${s.fundingProjects ?? "nothing"}`}</div>
          <div className="row submit-row">
            <LoadingButton loading={busy === "link-funding"} disabled={!isAdmin("funding") || Boolean(s.fundingProjects) || !projectsKnowsFunding} onClick={() => void run("link-funding", "set_projects", (toolkit, c) => call(toolkit, c.funding, "set_projects", c.projects))}>
              {fundingLinked ? "Linked" : "Link BROProjects"}
            </LoadingButton>
          </div>
        </Step>
        <Step title="Market → BROProjects (set_ledger)" hint="Market admin only. Lets BROProjects call the market's cover entrypoint to pay shortfalls from the reserve.">
          <div className="info">{`Market currently linked to: ${s.marketLedger ?? "nothing"}`}</div>
          <div className="row submit-row">
            <LoadingButton loading={busy === "link-market"} disabled={!isAdmin("market") || marketLinked} onClick={() => void run("link-market", "set_ledger", (toolkit, c) => call(toolkit, c.market, "set_ledger", c.projects))}>
              {marketLinked ? "Linked" : "Link Market"}
            </LoadingButton>
          </div>
        </Step>
      </Section>

      <Section title="5. Fund the Reserve">
        <label>{symbol} amount
          <input type="number" min="0" step="any" value={broAmount} onChange={(event) => setBroAmount(event.target.value)} />
        </label>
        <p className="hint">
          Transfers {symbol} from your wallet ({formatBro(s.walletBro)}) to the market. Current reserve: {formatBro(s.reserveBro)}.
          It covers milestone and settlement shortfalls when {symbol} loses value against USD.
        </p>
        <LoadingButton loading={busy === "bro"} disabled={!wallet.address} onClick={fundBro}>Send {symbol}</LoadingButton>

        <label>XTZ amount (optional)
          <input type="number" min="0" step="any" value={xtzAmount} onChange={(event) => setXtzAmount(event.target.value)} />
        </label>
        <p className="hint">Current XTZ reserve: {formatUnits(s.reserveXtz, 6)} XTZ. The market admin can swap XTZ for {symbol} on BRODex to top up the reserve.</p>
        <LoadingButton className="secondary" loading={busy === "xtz"} disabled={!wallet.address} onClick={fundXtz}>Send XTZ</LoadingButton>
      </Section>

      <Section title="6. Push the BRO/USD Price">
        <label>USD price of 1 {symbol}
          <input type="number" min="0" step="any" value={priceInput} onChange={(event) => setPriceInput(event.target.value)} placeholder="e.g. 0.05" />
        </label>
        <p className="hint">
          Oracle only{isOracle ? "" : " (connect the oracle wallet)"}. Current: {s.price > 0n ? `$${usdFromPrice(s.price, s.token.decimals)}` : "not set"}.
          BROFunding and BROProjects reject prices older than {s.maxPriceAge.toString()} seconds, so the oracle must keep pushing.
        </p>
        <LoadingButton loading={busy === "price"} disabled={!isOracle} onClick={pushPrice}>Push Price</LoadingButton>
      </Section>

      <Section title="7. Approver NFT (set_nft)">
        <p className="hint">BROProjects admin only. Holders of this FA2 token may approve milestones and mark defaults. The token contract must expose the <code>get_balance_of</code> on-chain view.</p>
        <label>NFT contract address
          <input value={nftAddress} onChange={(event) => setNftAddress(event.target.value)} placeholder="KT1..." />
        </label>
        <label>Token ID
          <input type="number" min="0" value={nftTokenId} onChange={(event) => setNftTokenId(event.target.value)} />
        </label>
        <div className="row submit-row">
          <LoadingButton loading={busy === "nft"} disabled={!isAdmin("projects")} onClick={() => setNft(false)}>Set NFT</LoadingButton>
          {s.nft && <LoadingButton className="secondary" loading={busy === "nft-clear"} disabled={!isAdmin("projects")} onClick={() => setNft(true)}>Remove NFT</LoadingButton>}
        </div>
      </Section>

      <Section title="8. Rules">
        <label htmlFor="lateFee">Late fee (basis points per day)</label>
        <div className="row">
          <input id="lateFee" className="grow" type="number" min="0" max="10000" value={lateFee} onChange={(event) => setLateFee(event.target.value)} />
          <LoadingButton className="secondary" loading={busy === "fee"} disabled={!isAdmin("funding")} onClick={() => setNumber("fee", "set_late_fee", lateFee, (n) => n >= 0 && n <= 10000, "Late fee must be between 0 and 10000 bps.", "funding")}>Update</LoadingButton>
        </div>
        <p className="hint">BROFunding admin. Snapshotted into projects submitted afterwards.</p>
        <label htmlFor="graceDays">Grace period (days)</label>
        <div className="row">
          <input id="graceDays" className="grow" type="number" min="0" value={graceDays} onChange={(event) => setGraceDays(event.target.value)} />
          <LoadingButton className="secondary" loading={busy === "grace"} disabled={!isAdmin("projects")} onClick={() => setNumber("grace", "set_grace_days", graceDays, (n) => n >= 0, "Grace period must be a non-negative number of days.", "projects")}>Update</LoadingButton>
        </div>
        <p className="hint">BROProjects admin. Days past a due date or term end before a project can be defaulted. Applies to all projects immediately.</p>
        <label htmlFor="maxPriceAge">Max price age (seconds)</label>
        <div className="row">
          <input id="maxPriceAge" className="grow" type="number" min="1" value={maxPriceAge} onChange={(event) => setMaxPriceAge(event.target.value)} />
          <LoadingButton className="secondary" loading={busy === "age"} disabled={!isAdmin("market")} onClick={() => setNumber("age", "set_max_price_age", maxPriceAge, (n) => n > 0, "Max price age must be a positive number of seconds.", "market")}>Update</LoadingButton>
        </div>
        <p className="hint">Market admin. How long a pushed price stays usable.</p>
      </Section>

      <Section title="9. Pause">
        <Step title={`BROFunding: ${s.fundingPaused ? "paused" : "running"}`} hint="BROFunding admin. While paused, submitting projects, investing and refunds are disabled.">
          <LoadingButton className={s.fundingPaused ? undefined : "secondary"} loading={busy === "pause-funding"} disabled={!isAdmin("funding")} onClick={() => void run("pause-funding", s.fundingPaused ? "Unpause BROFunding" : "Pause BROFunding", (toolkit, c) => call(toolkit, c.funding, "pause", !c.fundingPaused))}>
            {s.fundingPaused ? "Unpause BROFunding" : "Pause BROFunding"}
          </LoadingButton>
        </Step>
        <Step title={`BROProjects: ${s.projectsPaused ? "paused" : "running"}`} hint="BROProjects admin. While paused, claiming milestones, repaying and claiming payouts are disabled. Approvals and defaults still work.">
          <LoadingButton className={s.projectsPaused ? undefined : "secondary"} loading={busy === "pause-projects"} disabled={!isAdmin("projects")} onClick={() => void run("pause-projects", s.projectsPaused ? "Unpause BROProjects" : "Pause BROProjects", (toolkit, c) => call(toolkit, c.projects, "pause", !c.projectsPaused))}>
            {s.projectsPaused ? "Unpause BROProjects" : "Pause BROProjects"}
          </LoadingButton>
        </Step>
      </Section>

      <Section title="10. Change Market (set_market)">
        <label>New market assistant address
          <input value={newMarket} onChange={(event) => setNewMarket(event.target.value)} placeholder="KT1..." />
        </label>
        <p className="hint">
          Each contract's admin updates its own pointer; switch both so they price deposits and payouts the same way.
          The new market's admin must then link it to BROProjects with <code>set_ledger</code>, and its reserve must be funded.
          This page reads the market from BROFunding, so reload after switching.
        </p>
        <div className="row">
          <LoadingButton className="secondary" loading={busy === "market-funding"} disabled={!isAdmin("funding")} onClick={() => changeMarket("funding")}>Set on BROFunding</LoadingButton>
          <LoadingButton className="secondary" loading={busy === "market-projects"} disabled={!isAdmin("projects")} onClick={() => changeMarket("projects")}>Set on BROProjects</LoadingButton>
        </div>
      </Section>

      <Section title="11. Transfer Admin (set_admin)">
        <p className="hint">Takes effect immediately, with no confirmation step from the new admin. Double-check the address: a wrong one locks you out of that contract.</p>
        {(["funding", "projects", "market"] as const).map((key) => <div key={key}>
          <label htmlFor={`admin-${key}`}>New {CONTRACT_NAMES[key]} admin (current: {s.admins[key]}{adminTag(key)})</label>
          <div className="row">
            <input id={`admin-${key}`} className="grow" value={newAdmins[key]} onChange={(event) => setNewAdmins((current) => ({ ...current, [key]: event.target.value }))} placeholder="tz1... or KT1..." />
            <LoadingButton className="secondary" loading={busy === `admin-${key}`} disabled={!isAdmin(key)} onClick={() => transferAdmin(key)}>Transfer</LoadingButton>
          </div>
        </div>)}
      </Section>
    </>}

    <Status messages={messages} />
  </Page>;
}
