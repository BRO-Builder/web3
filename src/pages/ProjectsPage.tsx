import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LoadingButton, NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { fetchTokenMetadata, type TokenMetadata } from "../shared/tokenMetadata";
import { formatUnits, parseUnits, toBigInt } from "../shared/units";
import { isValidAddress, useWallet } from "../shared/tezos";
import { type RateQuote, fetchRate } from "../lib/rate";
import {
  PRICE_SCALE,
  fetchTokenBalance,
  isPriceStale,
  priceFromUsd,
  readOption,
  usdFromPrice,
} from "../shared/broProjects";

const MAX_LOADED_PROJECTS = 50;

type Milestone = {
  description: string;
  pctBps: bigint;
  durationDays: bigint;
  usd: bigint;
  escrowBro: bigint;
  dueAt: string | null;
  approvedAt: string | null;
  netUsd: bigint;
  lateFeeUsd: bigint;
  claimed: boolean;
};

// A listing from BROFunding merged with its BROProjects record once launched
// (same project id). Milestone progress fields stay empty until launch.
type Project = {
  id: number;
  contractor: string;
  projectType: string;
  title: string;
  scope: string;
  site: { street: string; city: string; state: string; zip: string };
  owner: { name: string; phone: string; email: string };
  estCompletion: string;
  fundingDeadline: string;
  budgetUsd: bigint;
  interestBps: bigint;
  termMonths: bigint;
  lateFeeBpsPerDay: bigint;
  fundedUsd: bigint;
  fundedBro: bigint;
  fundedAt: string | null;
  milestones: Milestone[];
  currentMilestone: number;
  repaidUsd: bigint;
  repaidBro: bigint;
  settledPoolBro: bigint;
  uncoveredBro: bigint;
  launched: boolean;
  // BROFunding: Funding / Failed / Cancelled; BROProjects once launched:
  // Active / Repaying / Repaid / Defaulted
  status: string;
};

type Investment = { usd: bigint; bro: bigint; payoutClaimed: boolean };

type System = {
  funding: string;
  projectsContract: string;
  fundingAdmin: string;
  fundingPaused: boolean;
  fundingProjects: string | null;
  projectsPaused: boolean;
  graceDays: bigint;
  nft: { address: string; tokenId: string } | null;
  market: string;
  oracle: string;
  marketLedger: string | null;
  tokenAddress: string;
  tokenId: string;
  token: TokenMetadata;
  price: bigint;
  priceUpdatedAt: string;
  maxPriceAge: bigint;
  reserve: bigint | null;
  projects: Project[];
};

type MilestoneInput = { description: string; pct: string; days: string };

type ProjectForm = {
  projectType: string;
  title: string;
  scope: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  estCompletion: string;
  fundingDeadline: string;
  budget: string;
  interest: string;
  termMonths: string;
  milestones: MilestoneInput[];
};

const EMPTY_FORM: ProjectForm = {
  projectType: "residential",
  title: "",
  scope: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  ownerName: "",
  ownerPhone: "",
  ownerEmail: "",
  estCompletion: "",
  fundingDeadline: "",
  budget: "",
  interest: "8",
  termMonths: "12",
  milestones: [{ description: "", pct: "100", days: "30" }],
};

function variantName(value: object) {
  return Object.keys(value)[0] ?? "Unknown";
}

function sortedValues(map: any): any[] {
  return Array.from(map.entries() as Iterable<[unknown, unknown]>)
    .sort(([left], [right]) => Number(String(left)) - Number(String(right)))
    .map(([, value]) => value);
}

function decodeMilestone(terms: any, progress: any | undefined): Milestone {
  return {
    description: terms.description,
    pctBps: toBigInt(terms.pct_bps),
    durationDays: toBigInt(terms.duration_days),
    usd: toBigInt(terms.usd),
    escrowBro: progress ? toBigInt(progress.escrow_bro) : 0n,
    dueAt: progress ? readOption(progress.due_at) : null,
    approvedAt: progress ? readOption(progress.approved_at) : null,
    netUsd: progress ? toBigInt(progress.net_usd) : 0n,
    lateFeeUsd: progress ? toBigInt(progress.late_fee_usd) : 0n,
    claimed: progress ? Boolean(progress.claimed) : false,
  };
}

function decodeProject(id: number, listing: any, runtime: any | undefined): Project {
  const progress = runtime ? sortedValues(runtime.milestones) : [];
  return {
    id,
    contractor: listing.contractor,
    projectType: listing.project_type,
    title: listing.title,
    scope: listing.scope,
    site: listing.site,
    owner: listing.owner,
    estCompletion: listing.est_completion,
    fundingDeadline: listing.funding_deadline,
    budgetUsd: toBigInt(listing.budget_usd),
    interestBps: toBigInt(listing.interest_bps),
    termMonths: toBigInt(listing.term_months),
    lateFeeBpsPerDay: toBigInt(listing.late_fee_bps_per_day),
    fundedUsd: toBigInt(listing.funded_usd),
    fundedBro: runtime ? toBigInt(runtime.funded_bro) : toBigInt(listing.funded_bro),
    fundedAt: runtime ? runtime.funded_at : readOption(listing.funded_at),
    milestones: sortedValues(listing.milestones).map((terms, index) => decodeMilestone(terms, progress[index])),
    currentMilestone: runtime ? Number(toBigInt(runtime.current_milestone)) : 0,
    repaidUsd: runtime ? toBigInt(runtime.repaid_usd) : 0n,
    repaidBro: runtime ? toBigInt(runtime.repaid_bro) : 0n,
    settledPoolBro: runtime ? toBigInt(runtime.settled_pool_bro) : 0n,
    uncoveredBro: runtime ? toBigInt(runtime.uncovered_bro) : 0n,
    launched: Boolean(runtime),
    status: variantName(runtime ? runtime.status : listing.status),
  };
}

function formatUsd(cents: bigint) {
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function formatBps(bps: bigint) {
  return `${formatUnits(bps, 2)}%`;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 7)}…${address.slice(-5)}` : "—";
}

function toTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function usdToBroUp(cents: bigint, price: bigint) {
  return (cents * price + PRICE_SCALE - 1n) / PRICE_SCALE;
}

function usdToBro(cents: bigint, price: bigint) {
  return cents * price / PRICE_SCALE;
}

function amountDue(project: Project) {
  return project.budgetUsd * (10000n + project.interestBps) / 10000n - project.repaidUsd;
}

function defaultEligibleAt(project: Project, graceDays: bigint) {
  if (!project.fundedAt) return null;
  const grace = Number(graceDays) * 86400_000;
  let at = Date.parse(project.fundedAt) + Number(project.termMonths) * 30 * 86400_000 + grace;
  const current = project.milestones[project.currentMilestone];
  if (project.status === "Active" && current?.dueAt) {
    at = Math.min(at, Date.parse(current.dueAt) + grace);
  }
  return at;
}

function StatusTag({ status }: { status: string }) {
  const tone = ["Active", "Repaid"].includes(status)
    ? "ok"
    : ["Funding", "Repaying"].includes(status) ? "warn" : "";
  return <span className={`tag ${tone}`}>{status}</span>;
}

function Action({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="action">
    <h4>{title}</h4>
    {hint && <p className="hint">{hint}</p>}
    {children}
  </div>;
}

export function ProjectsPage() {
  const wallet = useWallet();
  const storages = useRef<{ funding: any; projects: any } | null>(null);
  const [fundingAddress, setFundingAddress] = useState("");
  const [projectsAddress, setProjectsAddress] = useState("");
  const [system, setSystem] = useState<System | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [investment, setInvestment] = useState<Investment | null>(null);
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM);
  const [priceInput, setPriceInput] = useState("");
  const [investInput, setInvestInput] = useState("");
  const [repayInput, setRepayInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState(["Idle."]);
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  useEffect(() => {
    const budget = Number(form.budget);
    const termDays = Number(form.termMonths) * 30;
    setQuote(null);
    setForm((current) => current.interest === "" ? current : { ...current, interest: "" });

    if (!wallet.address || !(budget > 0) || !(termDays > 0)) {
      setQuoteStatus({ loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setQuoteStatus({ loading: true, error: null });
    const timer = setTimeout(async () => {
      try {
        const result = await fetchRate(
          { address: wallet.address!, loanAmount: budget, termDays, primo: true },
          controller.signal,
        );
        setQuote(result);
        setForm((current) => ({ ...current, interest: result.totalRatePct.toFixed(2) }));
        setQuoteStatus({ loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setQuoteStatus({ loading: false, error: getErrorMessage(error) });
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wallet.address, form.budget, form.termMonths]);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function loadInvestment(id: number | null) {
    setInvestment(null);
    if (id === null || !wallet.address || !storages.current) return;
    const key = { 0: id.toString(), 1: wallet.address };
    const [raw, claimed] = await Promise.all([
      storages.current.funding.investments.get(key),
      storages.current.projects.payouts_claimed.get(key),
    ]);
    setInvestment(raw
      ? { usd: toBigInt(raw.usd), bro: toBigInt(raw.bro), payoutClaimed: claimed !== undefined }
      : null);
  }

  async function loadContracts(keepSelection = false) {
    const funding = fundingAddress.trim();
    const projectsContract = projectsAddress.trim();
    if (!isValidAddress(funding) || !isValidAddress(projectsContract)) {
      log("Enter valid BROFunding and BROProjects contract addresses (KT1...).");
      return;
    }

    setBusy((current) => current ?? "load");
    try {
      const { toolkit } = await wallet.ensureWallet();
      const [fundingStorage, projectsStorage]: any[] = await Promise.all([
        toolkit.wallet.at(funding).then((contract) => contract.storage()),
        toolkit.wallet.at(projectsContract).then((contract) => contract.storage()),
      ]);
      const marketStorage: any = await (await toolkit.wallet.at(fundingStorage.market)).storage();
      const tokenId = fundingStorage.token_id.toString();

      let token: TokenMetadata;
      try {
        token = await fetchTokenMetadata(wallet.selected.api, fundingStorage.token_address, tokenId);
      } catch (error) {
        log(`Token metadata unavailable (${getErrorMessage(error)}). Showing raw base units.`);
        token = { symbol: "BRO", decimals: 0 };
      }

      const nextId = Number(toBigInt(fundingStorage.next_project_id));
      const ids = Array.from(
        { length: Math.min(nextId, MAX_LOADED_PROJECTS) },
        (_, index) => nextId - 1 - index,
      );
      const projects = await Promise.all(ids.map(async (id) => {
        const listing: any = await fundingStorage.projects.get(id.toString());
        const runtime = variantName(listing.status) === "Launched"
          ? await projectsStorage.projects.get(id.toString())
          : undefined;
        return decodeProject(id, listing, runtime);
      }));
      const nft = readOption<any>(projectsStorage.nft);

      storages.current = { funding: fundingStorage, projects: projectsStorage };
      setSystem({
        funding,
        projectsContract,
        fundingAdmin: fundingStorage.admin,
        fundingPaused: Boolean(fundingStorage.paused),
        fundingProjects: readOption<string>(fundingStorage.projects_contract),
        projectsPaused: Boolean(projectsStorage.paused),
        graceDays: toBigInt(projectsStorage.grace_days),
        nft: nft ? { address: nft.address, tokenId: nft.token_id.toString() } : null,
        market: fundingStorage.market,
        oracle: marketStorage.oracle,
        marketLedger: readOption<string>(marketStorage.ledger),
        tokenAddress: fundingStorage.token_address,
        tokenId,
        token,
        price: toBigInt(marketStorage.price),
        priceUpdatedAt: marketStorage.price_updated_at,
        maxPriceAge: toBigInt(marketStorage.max_price_age),
        reserve: await fetchTokenBalance(wallet.selected.api, fundingStorage.market, fundingStorage.token_address, tokenId),
        projects,
      });
      const selection = keepSelection ? selectedId : null;
      setSelectedId(selection);
      await loadInvestment(selection);
      log(`Loaded ${nextId} project(s)${nextId > MAX_LOADED_PROJECTS ? `, showing the latest ${MAX_LOADED_PROJECTS}` : ""}.`);
    } catch (error) {
      console.error(error);
      log(`Failed to load contracts: ${getErrorMessage(error)}`);
    } finally {
      setBusy((current) => current === "load" ? null : current);
    }
  }

  async function selectProject(id: number) {
    setSelectedId(id);
    setInvestInput("");
    setRepayInput("");
    try {
      await loadInvestment(id);
    } catch (error) {
      log(`Failed to load your investment: ${getErrorMessage(error)}`);
    }
  }

  // Sends one contract call (or a batch) and reloads both contracts afterwards.
  async function run(key: string, label: string, build: (toolkit: any) => Promise<any>) {
    if (!wallet.address) {
      log("Connect a wallet first.");
      return;
    }
    setBusy(key);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const operation = await build(toolkit);
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log(`${label} complete.`);
      await loadContracts(true);
    } catch (error) {
      log(`${label} failed: ${getErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  }

  // invest (BROFunding) and repay (BROProjects) pull BRO from the sender, so
  // that contract is made an FA2 operator only for the duration of the call.
  async function withOperator(toolkit: any, operator: string, call: (contract: any) => any) {
    if (!system || !wallet.address) throw new Error("Load the contracts first.");
    const token: any = await toolkit.wallet.at(system.tokenAddress);
    const contract: any = await toolkit.wallet.at(operator);
    const permission = { owner: wallet.address, operator, token_id: system.tokenId };
    return toolkit.wallet.batch()
      .withContractCall(token.methodsObject.update_operators([{ add_operator: permission }]))
      .withContractCall(call(contract))
      .withContractCall(token.methodsObject.update_operators([{ remove_operator: permission }]))
      .send();
  }

  async function contractCall(toolkit: any, address: string, entrypoint: string, argument: unknown) {
    const contract: any = await toolkit.wallet.at(address);
    return contract.methodsObject[entrypoint](argument).send();
  }

  function updatePrice() {
    if (!system) return;
    const price = priceFromUsd(priceInput, system.token.decimals);
    if (!price || price <= 0n) {
      log("Enter a positive USD price for 1 BRO (up to 8 decimals).");
      return;
    }
    log(`Pushing price: ${price} (BRO base units per cent x 10^6).`);
    void run("price", "update_price", (toolkit) => contractCall(toolkit, system.market, "update_price", price.toString()));
  }

  function validateProjectForm() {
    const budget = parseUnits(form.budget, 2);
    const interest = parseUnits(form.interest, 2);
    const term = Number(form.termMonths);
    const deadline = new Date(form.fundingDeadline);
    const completion = new Date(form.estCompletion);

    if (quoteStatus.loading) return { error: "Wait for the interest rate quote to finish." };
    if (!quote || !form.interest) return { error: "No interest rate quote yet. Connect a wallet and enter a budget and term." };
    if (parseUnits(form.interest, 2)! > 5000n) {
      return { error: `The quoted interest of ${form.interest}% exceeds the 50% contract limit. Choose a shorter term.` };
    }

    if (!form.title.trim() || !form.scope.trim()) return { error: "Enter a project title and scope." };
    if (!budget || budget <= 0n) return { error: "Budget must be a positive USD amount with at most 2 decimals." };
    if (interest === null || interest < 50n || interest > 5000n) return { error: "Interest must be between 0.5% and 50%." };
    if (!Number.isInteger(term) || term < 1 || term > 60) return { error: "Term must be between 1 and 60 months." };
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) return { error: "Funding deadline must be in the future." };
    if (Number.isNaN(completion.getTime())) return { error: "Enter an estimated completion date." };

    const milestones = [];
    let total = 0n;
    for (const [index, milestone] of form.milestones.entries()) {
      const pct = parseUnits(milestone.pct, 2);
      const days = Number(milestone.days);
      if (!milestone.description.trim()) return { error: `Milestone ${index + 1} needs a description.` };
      if (!pct || pct <= 0n) return { error: `Milestone ${index + 1} needs a positive percentage.` };
      if (!Number.isInteger(days) || days <= 0) return { error: `Milestone ${index + 1} needs a positive duration in days.` };
      total += pct;
      milestones.push({ description: milestone.description.trim(), pct_bps: pct.toString(), duration_days: days.toString() });
    }
    if (total !== 10000n) return { error: `Milestone percentages must add up to 100% (currently ${formatBps(total)}).` };

    return {
      value: {
        project_type: form.projectType,
        title: form.title.trim(),
        scope: form.scope.trim(),
        site: { street: form.street.trim(), city: form.city.trim(), state: form.state.trim(), zip: form.zip.trim() },
        owner: { name: form.ownerName.trim(), phone: form.ownerPhone.trim(), email: form.ownerEmail.trim() },
        est_completion: toTimestamp(completion),
        funding_deadline: toTimestamp(deadline),
        budget_usd: budget.toString(),
        interest_bps: interest.toString(),
        term_months: term.toString(),
        milestones,
      },
    };
  }

  function submitProject() {
    const result = validateProjectForm();
    if (result.error || !result.value) {
      log(result.error ?? "Enter valid project details.");
      return;
    }
    void run("submit", "submit_project", async (toolkit) => {
      const operation = await contractCall(toolkit, system!.funding, "submit_project", result.value);
      setForm(EMPTY_FORM);
      return operation;
    });
  }

  function updateForm(name: keyof ProjectForm) {
    return (event: { target: { value: string } }) => setForm((current) => ({ ...current, [name]: event.target.value }));
  }

  function updateMilestone(index: number, name: keyof MilestoneInput, value: string) {
    setForm((current) => ({
      ...current,
      milestones: current.milestones.map((milestone, i) => i === index ? { ...milestone, [name]: value } : milestone),
    }));
  }

  const project = system?.projects.find((item) => item.id === selectedId) ?? null;
  const decimals = system?.token.decimals ?? 0;
  const symbol = system?.token.symbol ?? "BRO";
  const formatBro = (units: bigint) => `${formatUnits(units, decimals)} ${symbol}`;
  const stale = system ? isPriceStale(system.price, system.priceUpdatedAt, system.maxPriceAge) : true;
  const isFundingAdmin = Boolean(system && wallet.address === system.fundingAdmin);
  const isOracle = Boolean(system && wallet.address === system.oracle);
  const fundingLinked = Boolean(system && system.fundingProjects === system.projectsContract);
  const marketLinked = Boolean(system && system.marketLedger === system.projectsContract);
  const milestoneTotal = form.milestones.reduce((sum, milestone) => sum + (parseUnits(milestone.pct, 2) ?? 0n), 0n);

  function renderActions(p: Project, sys: System) {
    const now = Date.now();
    const deadlinePassed = now > Date.parse(p.fundingDeadline);
    const isContractor = wallet.address === p.contractor;
    const hasInvestment = Boolean(investment && investment.bro > 0n);
    const actions: ReactNode[] = [];

    if (p.status === "Funding" && !deadlinePassed) {
      const remaining = usdToBroUp(p.budgetUsd - p.fundedUsd, sys.price);
      actions.push(<Action key="invest" title="Invest" hint={<>
        {stale ? "The market price is stale; ask the oracle to push a fresh price before investing. " : `About ${formatBro(remaining)} fully funds the remaining ${formatUsd(p.budgetUsd - p.fundedUsd)}. `}
        Deposits above that are capped; the deposit that completes funding launches the project on BROProjects.
        This batch makes BROFunding an operator of your {symbol}, invests, then removes the operator.
        {sys.fundingPaused && " BROFunding is paused."}
        {!fundingLinked && " BROFunding is not linked to BROProjects yet, so the deposit that completes funding will fail."}
      </>}>
        <div className="row">
          <input className="grow" type="number" min="0" step="any" value={investInput} onChange={(event) => setInvestInput(event.target.value)} placeholder={`Max ${symbol} to deposit`} />
          {!stale && <button className="secondary small" onClick={() => setInvestInput(formatUnits(remaining, decimals))}>Fill remaining</button>}
          <LoadingButton loading={busy === "invest"} disabled={!wallet.address || stale || sys.fundingPaused} onClick={() => {
            const amount = parseUnits(investInput, decimals);
            if (!amount || amount <= 0n) {
              log(`Enter a positive ${symbol} amount with at most ${decimals} decimals.`);
              return;
            }
            void run("invest", "invest", (toolkit) => withOperator(toolkit, sys.funding, (funding) => funding.methodsObject.invest({ project_id: p.id.toString(), max_bro: amount.toString() })));
          }}>Invest</LoadingButton>
        </div>
      </Action>);
    }

    if (p.status === "Funding" && isFundingAdmin) {
      actions.push(<Action key="cancel" title="Cancel submission" hint="BROFunding admin only. Investors can then refund their deposits.">
        <LoadingButton className="secondary" loading={busy === "cancel"} onClick={() => void run("cancel", "cancel_project", (toolkit) => contractCall(toolkit, sys.funding, "cancel_project", p.id.toString()))}>Cancel Project</LoadingButton>
      </Action>);
    }

    if (hasInvestment && (["Failed", "Cancelled"].includes(p.status) || (p.status === "Funding" && deadlinePassed))) {
      actions.push(<Action key="refund" title="Refund" hint={`Returns your deposit of ${formatBro(investment!.bro)} from BROFunding.${sys.fundingPaused ? " BROFunding is paused." : ""}`}>
        <LoadingButton loading={busy === "refund"} disabled={sys.fundingPaused} onClick={() => void run("refund", "refund", (toolkit) => contractCall(toolkit, sys.funding, "refund", p.id.toString()))}>Refund</LoadingButton>
      </Action>);
    }

    if (p.status === "Active" && p.currentMilestone < p.milestones.length) {
      const current = p.milestones[p.currentMilestone];
      actions.push(<Action key="approve" title={`Approve milestone ${p.currentMilestone + 1}`} hint={<>
        BROProjects admin or approver NFT holder. "{current.description}" is due {formatDate(current.dueAt)}; each late day costs {formatBps(p.lateFeeBpsPerDay)} of its {formatUsd(current.usd)}.
      </>}>
        <LoadingButton loading={busy === "approve"} disabled={!wallet.address} onClick={() => void run("approve", "approve_milestone", (toolkit) => contractCall(toolkit, sys.projectsContract, "approve_milestone", p.id.toString()))}>Approve Milestone</LoadingButton>
      </Action>);
    }

    if (p.status === "Active" && isContractor) {
      const claimable = p.milestones.slice(0, p.currentMilestone).filter((milestone) => !milestone.claimed);
      const netUsd = claimable.reduce((sum, milestone) => sum + milestone.netUsd, 0n);
      actions.push(<Action key="claim" title="Claim approved milestones" hint={claimable.length
        ? `${claimable.length} milestone(s) worth ${formatUsd(netUsd)}${stale ? "; the price is stale, so claiming will fail until it is refreshed" : `, about ${formatBro(usdToBro(netUsd, sys.price))} at today's price`}.${sys.projectsPaused ? " BROProjects is paused." : ""}`
        : "Nothing approved to claim yet."}>
        <LoadingButton loading={busy === "claim"} disabled={!claimable.length || stale || sys.projectsPaused} onClick={() => void run("claim", "claim_milestone", (toolkit) => contractCall(toolkit, sys.projectsContract, "claim_milestone", p.id.toString()))}>Claim</LoadingButton>
      </Action>);
    }

    if (p.status === "Repaying") {
      const due = amountDue(p);
      actions.push(<Action key="repay" title="Repay" hint={<>
        {formatUsd(due)} still owed (budget + {formatBps(p.interestBps)} interest), paid in {symbol} at the price on the day of each installment
        {stale ? ". The price is stale; repayment will fail until it is refreshed." : `, about ${formatBro(usdToBroUp(due, sys.price))} today.`} Anyone may pay.
        This batch makes BROProjects an operator of your {symbol}, repays, then removes the operator.{sys.projectsPaused && " BROProjects is paused."}
      </>}>
        <div className="row">
          <input className="grow" type="number" min="0" step="0.01" value={repayInput} onChange={(event) => setRepayInput(event.target.value)} placeholder="USD amount" />
          <button className="secondary small" onClick={() => setRepayInput(formatUnits(due, 2))}>Pay all</button>
          <LoadingButton loading={busy === "repay"} disabled={!wallet.address || stale || sys.projectsPaused} onClick={() => {
            const cents = parseUnits(repayInput, 2);
            if (!cents || cents <= 0n) {
              log("Enter a positive USD amount with at most 2 decimals.");
              return;
            }
            void run("repay", "repay", (toolkit) => withOperator(toolkit, sys.projectsContract, (projects) => projects.methodsObject.repay({ project_id: p.id.toString(), usd_cents: cents.toString() })));
          }}>Repay</LoadingButton>
        </div>
      </Action>);
    }

    if (p.status === "Active" || p.status === "Repaying") {
      const eligibleAt = defaultEligibleAt(p, sys.graceDays);
      actions.push(<Action key="default" title="Mark as defaulted" hint={`BROProjects admin or approver NFT holder. ${eligibleAt
        ? eligibleAt < now ? "This project is overdue and can be defaulted now." : `Possible after ${new Date(eligibleAt).toLocaleString()}.`
        : ""} Unclaimed escrow joins the investor pool.`}>
        <LoadingButton className="secondary" loading={busy === "default"} disabled={!wallet.address} onClick={() => void run("default", "mark_default", (toolkit) => contractCall(toolkit, sys.projectsContract, "mark_default", p.id.toString()))}>Mark Default</LoadingButton>
      </Action>);
    }

    if (hasInvestment && (p.status === "Repaid" || p.status === "Defaulted")) {
      const payout = p.fundedBro > 0n ? p.settledPoolBro * investment!.bro / p.fundedBro : 0n;
      actions.push(<Action key="payout" title="Claim payout" hint={investment!.payoutClaimed ? "Already claimed." : `Your share of the settled pool: ${formatBro(payout)}.${sys.projectsPaused ? " BROProjects is paused." : ""}`}>
        <LoadingButton loading={busy === "payout"} disabled={investment!.payoutClaimed || sys.projectsPaused} onClick={() => void run("payout", "claim_payout", (toolkit) => contractCall(toolkit, sys.projectsContract, "claim_payout", p.id.toString()))}>Claim Payout</LoadingButton>
      </Action>);
    }

    return actions.length ? actions : <p className="hint">No actions available for your wallet at this stage.</p>;
  }

  return <Page wide title="BRO Projects" subtitle="Submit and fund projects on BROFunding, then track milestones, repayment and settlement on BROProjects, priced and backed by BROMarketAssistant.">
    <NetworkWallet wallet={wallet} />

    <Section title="3. Contracts">
      <label>BROFunding contract address
        <input value={fundingAddress} onChange={(event) => setFundingAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <label>BROProjects contract address
        <input value={projectsAddress} onChange={(event) => setProjectsAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <p className="hint">The market assistant, token and price are read from BROFunding's storage.</p>
      <div className="row">
        <LoadingButton className="secondary" loading={busy === "load"} onClick={() => void loadContracts()}>{system ? "Reload" : "Load Contracts"}</LoadingButton>
      </div>
      {system && <div className="info">
        {[
          `BROFunding admin: ${system.fundingAdmin}${system.fundingPaused ? "  (PAUSED)" : ""}`,
          `BROProjects: ${system.projectsPaused ? "PAUSED" : "running"}`,
          `Approver NFT: ${system.nft ? `${system.nft.address} #${system.nft.tokenId}` : "none (BROProjects admin only)"}`,
          `Market: ${system.market}`,
          `Oracle: ${system.oracle}`,
          `Token: ${system.token.symbol} (${system.tokenAddress}, id ${system.tokenId})`,
          `Price: ${system.price > 0n ? `$${usdFromPrice(system.price, decimals)} per ${symbol}` : "not set"}, updated ${system.price > 0n ? formatDate(system.priceUpdatedAt) : "never"}${stale ? "  (STALE)" : ""}`,
          `Reserve: ${system.reserve === null ? "unknown" : formatBro(system.reserve)}`,
        ].join("\n")}
      </div>}
    </Section>

    {system && (!fundingLinked || !marketLinked) && <div className="note">
      <strong>Setup incomplete:</strong>{" "}
      {!fundingLinked && "BROFunding is not linked to this BROProjects, so fully funded projects cannot launch. "}
      {!marketLinked && "The market assistant is not linked to this BROProjects, so claims and settlements that need the reserve will fail. "}
      <Link to="/deployment-projects-setup">Open the projects setup page &rarr;</Link>
    </div>}

    {system && <Section title="4. Price Feed">
      <Action title="Update BRO/USD price" hint={`Oracle only${isOracle ? "" : " (connect the oracle wallet)"}. Prices older than ${system.maxPriceAge} seconds are rejected by BROFunding and BROProjects.`}>
        <div className="row">
          <input className="grow" type="number" min="0" step="any" value={priceInput} onChange={(event) => setPriceInput(event.target.value)} placeholder={`USD price of 1 ${symbol}, e.g. 0.05`} />
          <LoadingButton loading={busy === "price"} disabled={!isOracle} onClick={updatePrice}>Push Price</LoadingButton>
        </div>
      </Action>
      <p className="hint">Linking, the approver NFT, reserve funding, rules, pausing and admin transfers are on the <Link to="/deployment-projects-setup">projects setup page</Link>.</p>
    </Section>}

    {system && <Section title="5. Submit a Project">
      <div className="grid-2">
        <label>Project type
          <select value={form.projectType} onChange={updateForm("projectType")}>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
        </label>
        <label>Title
          <input value={form.title} onChange={updateForm("title")} placeholder="e.g. Kitchen remodel" />
        </label>
      </div>
      <label>Scope of work
        <textarea className="short" value={form.scope} onChange={updateForm("scope")} placeholder="e.g. Cabinets, counters and plumbing" />
      </label>
      <div className="grid-2">
        <label>Site street<input value={form.street} onChange={updateForm("street")} /></label>
        <label>City<input value={form.city} onChange={updateForm("city")} /></label>
        <label>State<input value={form.state} onChange={updateForm("state")} /></label>
        <label>ZIP<input value={form.zip} onChange={updateForm("zip")} /></label>
        <label>Owner name<input value={form.ownerName} onChange={updateForm("ownerName")} /></label>
        <label>Owner phone<input value={form.ownerPhone} onChange={updateForm("ownerPhone")} /></label>
        <label>Owner email<input type="email" value={form.ownerEmail} onChange={updateForm("ownerEmail")} /></label>
        <label>Estimated completion<input type="date" value={form.estCompletion} onChange={updateForm("estCompletion")} /></label>
        <label>Budget (USD)<input type="number" min="0" step="0.01" value={form.budget} onChange={updateForm("budget")} placeholder="e.g. 25000" /></label>
        <label>Funding deadline<input type="datetime-local" value={form.fundingDeadline} onChange={updateForm("fundingDeadline")} /></label>
        <label>Total interest for term (%)
          <input type="number" value={form.interest} readOnly placeholder={wallet.address ? "Enter budget and term" : "Connect a wallet"} />
        </label>
        <label>Repayment term (months)<input type="number" min="1" max="60" value={form.termMonths} onChange={updateForm("termMonths")} /></label>
      </div>
      {quoteStatus.loading && <p className="hint">Fetching rate…</p>}
      {quoteStatus.error && <p className="hint">Could not get a rate: {quoteStatus.error}</p>}
      {quote && <div className="info">
        {[
          `Risk: ${quote.riskCategory} (score ${quote.totalScore}/100, ${quote.selfReportedPoints} self-reported)`,
          `Rate: ${quote.monthlyRatePct}% per month, ${quote.dailyRatePct}% per day after the ${quote.billableDays}-day minimum`,
          `Interest: ${formatUsd(BigInt(Math.round(quote.totalInterestUsd * 100)))} · Repayment: ${formatUsd(BigInt(Math.round(quote.totalRepaymentUsd * 100)))}`,
          ...quote.limitations.map((item) => `• ${item}`),
        ].join("\n")}
      </div>}
      <p className="hint">Interest is quoted by the BRO rate API for your wallet, budget and term, and applied as a flat percentage of the budget. It must be between 0.5% and 50%; the term between 1 and 60 months.</p>

      <h4>Milestones <span className={`tag ${milestoneTotal === 10000n ? "ok" : "warn"}`}>{formatBps(milestoneTotal)} of budget</span></h4>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Description</th><th>% of budget</th><th>Duration (days)</th><th /></tr></thead>
          <tbody>
            {form.milestones.map((milestone, index) => <tr key={index}>
              <td>{index + 1}</td>
              <td><input value={milestone.description} onChange={(event) => updateMilestone(index, "description", event.target.value)} placeholder="e.g. Demolition" /></td>
              <td><input type="number" min="0" max="100" step="0.01" value={milestone.pct} onChange={(event) => updateMilestone(index, "pct", event.target.value)} /></td>
              <td><input type="number" min="1" value={milestone.days} onChange={(event) => updateMilestone(index, "days", event.target.value)} /></td>
              <td>{form.milestones.length > 1 && <button className="secondary small" onClick={() => setForm((current) => ({ ...current, milestones: current.milestones.filter((_, i) => i !== index) }))}>Remove</button>}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="hint">Each milestone's clock starts when the previous one is approved (the first starts when funding closes).</p>
      <div className="row">
        <button className="secondary small" onClick={() => setForm((current) => ({ ...current, milestones: [...current.milestones, { description: "", pct: "", days: "30" }] }))}>Add Milestone</button>
      </div>
      <div className="row submit-row">
        <LoadingButton loading={busy === "submit"} disabled={!wallet.address || system.fundingPaused} onClick={submitProject}>Submit Project</LoadingButton>
      </div>
    </Section>}

    {system && <Section title="6. Projects">
      {system.projects.length === 0
        ? <p className="hint">No projects submitted yet.</p>
        : <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Budget</th><th>Funded</th><th>Milestones</th><th>Deadline</th><th /></tr></thead>
            <tbody>
              {system.projects.map((item) => <tr key={item.id} className={item.id === selectedId ? "selected" : undefined}>
                <td>{item.id}</td>
                <td>{item.title}{item.contractor === wallet.address && <span className="tag">yours</span>}</td>
                <td><StatusTag status={item.status} /></td>
                <td>{formatUsd(item.budgetUsd)}</td>
                <td>{formatBps(item.fundedUsd * 10000n / item.budgetUsd)}</td>
                <td>{item.currentMilestone} / {item.milestones.length}</td>
                <td>{new Date(item.fundingDeadline).toLocaleDateString()}</td>
                <td><button className="secondary small" onClick={() => void selectProject(item.id)}>View</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
    </Section>}

    {system && project && <Section title={`7. Project #${project.id}: ${project.title}`}>
      <div className="info">
        {[
          `Status: ${project.status} · ${project.projectType}`,
          `Contractor: ${project.contractor}`,
          `Scope: ${project.scope}`,
          `Site: ${[project.site.street, project.site.city, project.site.state, project.site.zip].filter(Boolean).join(", ") || "—"}`,
          `Owner: ${[project.owner.name, project.owner.phone, project.owner.email].filter(Boolean).join(" · ") || "—"}`,
          `Budget: ${formatUsd(project.budgetUsd)} at ${formatBps(project.interestBps)} over ${project.termMonths} month(s); late fee ${formatBps(project.lateFeeBpsPerDay)}/day`,
          `Funded: ${formatUsd(project.fundedUsd)} (${formatBro(project.fundedBro)}), deadline ${formatDate(project.fundingDeadline)}${project.fundedAt ? `, closed ${formatDate(project.fundedAt)}` : ""}`,
          `Est. completion: ${formatDate(project.estCompletion)}`,
          ...(project.launched
            ? [`Repaid: ${formatUsd(project.repaidUsd)} (${formatBro(project.repaidBro)}) of ${formatUsd(project.budgetUsd * (10000n + project.interestBps) / 10000n)}`]
            : []),
          ...(["Repaid", "Defaulted"].includes(project.status)
            ? [`Settled pool: ${formatBro(project.settledPoolBro)}${project.uncoveredBro > 0n ? `, uncovered ${formatBro(project.uncoveredBro)}` : ""}`]
            : []),
          `Your investment: ${investment ? `${formatUsd(investment.usd)} (${formatBro(investment.bro)})${investment.payoutClaimed ? ", payout claimed" : ""}` : wallet.address ? "none" : "connect a wallet"}`,
        ].join("\n")}
      </div>

      <h4>Milestones</h4>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Description</th><th>Share</th><th>USD</th><th>Escrow</th><th>Due</th><th>Approved</th><th>Late fee</th><th>State</th></tr></thead>
          <tbody>
            {project.milestones.map((milestone, index) => <tr key={index}>
              <td>{index + 1}</td>
              <td>{milestone.description}</td>
              <td>{formatBps(milestone.pctBps)}</td>
              <td>{formatUsd(milestone.usd)}</td>
              <td>{formatBro(milestone.escrowBro)}</td>
              <td>{milestone.dueAt ? formatDate(milestone.dueAt) : `${milestone.durationDays} days`}</td>
              <td>{formatDate(milestone.approvedAt)}</td>
              <td>{milestone.approvedAt ? formatUsd(milestone.lateFeeUsd) : "—"}</td>
              <td>{milestone.claimed
                ? <span className="tag ok">claimed</span>
                : milestone.approvedAt
                  ? <span className="tag warn">approved</span>
                  : index === project.currentMilestone && project.status === "Active"
                    ? <span className="tag warn">current</span>
                    : <span className="tag">pending</span>}</td>
            </tr>)}
          </tbody>
        </table>
      </div>

      <h4>Actions</h4>
      {renderActions(project, system)}
    </Section>}

    <Status messages={messages} />
  </Page>;
}
