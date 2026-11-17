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
  isPriceStale,
  priceFromUsd,
  readOption,
  usdFromPrice,
} from "../shared/broProjects";
import {
  DAY,
  type RuleMilestone,
  type RuleProject,
  amountDue,
  builderShare,
  ceilDays,
  defaultEligibleAt,
  drawSplit,
  drawnUsd,
  holdTarget,
  interestAt,
  latestMark,
  nextMark,
  nowSeconds,
  owed,
  pendingHoldPayout,
  toSeconds,
  usdToBro,
  usdToBroUp,
} from "../shared/projectRules";

const MAX_LOADED_PROJECTS = 50;
const MIN_RATE_BPS = 300n;
const MAX_RATE_BPS = 900n;

type Milestone = RuleMilestone & {
  description: string;
  pctBps: bigint;
  durationDays: bigint;
  approvedAt: bigint | null;
};

type Flows = { builderFeeBro: bigint; lateFeeBro: bigint; surplusBro: bigint; coveredBro: bigint };

// A listing from BROFunding merged with its BROProjects record once launched
// (same project id). Progress fields stay empty until launch. Times in seconds.
type Project = Omit<RuleProject, "milestones"> & {
  id: number;
  contractor: string;
  projectType: string;
  title: string;
  scope: string;
  site: { street: string; city: string; state: string; zip: string };
  owner: { name: string; phone: string; email: string };
  estCompletion: bigint;
  fundingDeadline: bigint;
  fundedUsd: bigint;
  fundedBro: bigint;
  milestones: Milestone[];
  // BROProjects: proposed by the contractor, waiting for the admin
  proposedEndDate: bigint | null;
  holdBro: bigint;
  repaidUsd: bigint;
  repaidBro: bigint;
  lateFeeUsd: bigint;
  released: boolean;
  investorBro: bigint;
  uncoveredBro: bigint;
  flows: Flows | null;
  launched: boolean;
};

type Investment = { usd: bigint; bro: bigint; claimedBro: bigint };

type System = {
  funding: string;
  projectsContract: string;
  fundingAdmin: string;
  fundingPaused: boolean;
  fundingProjects: string | null;
  builderShareBps: bigint;
  projectsAdmin: string;
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
  fundingWallet: string;
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
  monthlyRate: string;
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
  monthlyRate: "",
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

function optionSeconds(value: any) {
  return toSeconds(readOption<string>(value));
}

function decodeMilestone(terms: any, progress: any | undefined): Milestone {
  return {
    description: terms.description,
    pctBps: toBigInt(terms.pct_bps),
    durationDays: toBigInt(terms.duration_days),
    usd: toBigInt(terms.usd),
    escrowBro: progress ? toBigInt(progress.escrow_bro) : 0n,
    dueAt: progress ? optionSeconds(progress.due_at) : null,
    approvedAt: progress ? optionSeconds(progress.approved_at) : null,
    drawnAt: progress ? optionSeconds(progress.drawn_at) : null,
    outstandingUsd: progress ? toBigInt(progress.outstanding_usd) : 0n,
  };
}

function decodeProject(id: number, listing: any, runtime: any | undefined): Project {
  const progress = runtime ? sortedValues(runtime.milestones) : [];
  const big = (field: string) => runtime ? toBigInt(runtime[field]) : 0n;
  return {
    id,
    contractor: listing.contractor,
    projectType: listing.project_type,
    title: listing.title,
    scope: listing.scope,
    site: listing.site,
    owner: listing.owner,
    estCompletion: toSeconds(listing.est_completion)!,
    fundingDeadline: toSeconds(listing.funding_deadline)!,
    budgetUsd: toBigInt(listing.budget_usd),
    monthlyRateBps: toBigInt(listing.monthly_rate_bps),
    termMonths: toBigInt(listing.term_months),
    lateFeeBpsPerDay: toBigInt(listing.late_fee_bps_per_day),
    builderShareBps: toBigInt(listing.builder_share_bps),
    fundedUsd: toBigInt(listing.funded_usd),
    fundedBro: runtime ? toBigInt(runtime.funded_bro) : toBigInt(listing.funded_bro),
    fundedAt: runtime ? toSeconds(runtime.funded_at) : optionSeconds(listing.funded_at),
    endDate: runtime ? optionSeconds(runtime.end_date) : null,
    proposedEndDate: runtime ? optionSeconds(runtime.proposed_end_date) : null,
    milestones: sortedValues(listing.milestones).map((terms, index) => decodeMilestone(terms, progress[index])),
    currentMilestone: runtime ? Number(toBigInt(runtime.current_milestone)) : 0,
    holdUsd: big("hold_usd"),
    holdBro: big("hold_bro"),
    holdUsedUsd: big("hold_used_usd"),
    paidUntil: runtime ? toSeconds(runtime.paid_until) : null,
    closedUsdDays: big("closed_usd_days"),
    interestPaidUsd: big("interest_paid_usd"),
    repaidUsd: big("repaid_usd"),
    repaidBro: big("repaid_bro"),
    lateFeeUsd: big("late_fee_usd"),
    released: runtime ? Boolean(runtime.released) : false,
    investorBro: big("investor_bro"),
    uncoveredBro: big("uncovered_bro"),
    defaultDueUsd: big("default_due_usd"),
    flows: runtime
      ? {
        builderFeeBro: toBigInt(runtime.flows.builder_fee_bro),
        lateFeeBro: toBigInt(runtime.flows.late_fee_bro),
        surplusBro: toBigInt(runtime.flows.surplus_bro),
        coveredBro: toBigInt(runtime.flows.covered_bro),
      }
      : null,
    launched: Boolean(runtime),
    status: variantName(runtime ? runtime.status : listing.status),
  };
}

function formatUsd(cents: bigint) {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}$${(abs / 100n).toLocaleString("en-US")}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function formatBps(bps: bigint) {
  return `${formatUnits(bps, 2)}%`;
}

// Monthly bps to a daily percentage (monthly rate / 30), e.g. 400 -> 0.1333%.
function formatDailyRate(monthlyBps: bigint) {
  return `${formatUnits(monthlyBps * 100n / 30n, 4)}%`;
}

function formatTime(seconds: bigint | null) {
  return seconds === null ? "—" : new Date(Number(seconds) * 1000).toLocaleString();
}

function toTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isOpen(p: Project) {
  return p.status === "Active" || p.status === "Repaying";
}

function hasUndrawn(p: Project) {
  return !p.released && p.milestones.some((milestone) => milestone.drawnAt === null);
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

// A two-column table, laid out the same way for the estimate and the statement.
function Lines({ head, rows }: { head: string; rows: [string, string][] }) {
  return <div className="table-wrap">
    <table>
      <thead><tr><th>Line</th><th>{head}</th></tr></thead>
      <tbody>{rows.map(([line, value]) => <tr key={line}><td>{line}</td><td>{value}</td></tr>)}</tbody>
    </table>
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
  const [endDateInput, setEndDateInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState(["Idle."]);
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  // The monthly rate comes from the BRO rate API for the wallet, budget and
  // term; the contract accepts 3-9% a month.
  useEffect(() => {
    const budget = Number(form.budget);
    const termDays = Number(form.termMonths) * 30;
    setQuote(null);
    setForm((current) => current.monthlyRate === "" ? current : { ...current, monthlyRate: "" });

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
        if (!Number.isFinite(result.monthlyRatePct)) throw new Error("Rate API response is missing monthly_rate_pct");
        setQuote(result);
        setForm((current) => ({ ...current, monthlyRate: result.monthlyRatePct.toFixed(2) }));
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
      ? { usd: toBigInt(raw.usd), bro: toBigInt(raw.bro), claimedBro: claimed !== undefined ? toBigInt(claimed) : 0n }
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
        builderShareBps: toBigInt(fundingStorage.builder_share_bps),
        projectsAdmin: projectsStorage.admin,
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
        fundingWallet: marketStorage.funding_wallet,
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
    setEndDateInput("");
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
    const rate = parseUnits(form.monthlyRate, 2);
    const term = Number(form.termMonths);
    const deadline = new Date(form.fundingDeadline);
    const completion = new Date(form.estCompletion);

    if (quoteStatus.loading) return { error: "Wait for the interest rate quote to finish." };
    if (!quote || rate === null) return { error: "No interest rate quote yet. Connect a wallet and enter a budget and term." };
    if (rate < MIN_RATE_BPS || rate > MAX_RATE_BPS) {
      return { error: `The quoted monthly rate of ${form.monthlyRate}% is outside the 3%–9% contract limit, so this project can't be listed.` };
    }

    if (!form.title.trim() || !form.scope.trim()) return { error: "Enter a project title and scope." };
    if (!budget || budget <= 0n) return { error: "Budget must be a positive USD amount with at most 2 decimals." };
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
        monthly_rate_bps: rate.toString(),
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
  const isProjectsAdmin = Boolean(system && wallet.address === system.projectsAdmin);
  const isOracle = Boolean(system && wallet.address === system.oracle);
  const fundingLinked = Boolean(system && system.fundingProjects === system.projectsContract);
  const marketLinked = Boolean(system && system.marketLedger === system.projectsContract);
  const milestoneTotal = form.milestones.reduce((sum, milestone) => sum + (parseUnits(milestone.pct, 2) ?? 0n), 0n);

  // The hold the submission form will create: budget x monthly rate x term.
  const formBudget = parseUnits(form.budget, 2);
  const formRate = parseUnits(form.monthlyRate, 2);
  const formTerm = Number(form.termMonths);
  const formHold = formBudget && formRate && Number.isInteger(formTerm) && formTerm > 0
    ? holdTarget({ budgetUsd: formBudget, monthlyRateBps: formRate, termMonths: BigInt(formTerm) })
    : null;

  // An investor's share of a launched project, from their BRO deposit (the
  // contract splits every payout this way).
  function share(p: Project, amount: bigint, inv: Investment) {
    return p.fundedBro > 0n ? amount * inv.bro / p.fundedBro : 0n;
  }

  function claimable(p: Project, inv: Investment) {
    const total = share(p, p.investorBro, inv);
    return total > inv.claimedBro ? total - inv.claimedBro : 0n;
  }

  // Estimate before investing: the most a deposit worth `usd` can earn (all
  // drawn at launch and kept for the whole term), less BRO Builder's share.
  function renderEstimate(p: Project, usd: bigint) {
    const most = usd * p.monthlyRateBps * p.termMonths / 10000n;
    const fee = builderShare(most, p.builderShareBps);
    const net = most - fee;
    return <>
      <Lines head={`Your ${formatBps(p.budgetUsd > 0n ? usd * 10000n / p.budgetUsd : 0n)}`} rows={[
        ["Your deposit", formatUsd(usd)],
        [`Most you can earn (all ${formatUsd(p.budgetUsd)} drawn at launch, kept ${p.termMonths} month(s))`, `${formatUsd(most)} interest`],
        [`BRO Builder service fee (${formatBps(p.builderShareBps)} of your interest)`, `-${formatUsd(fee)}`],
        ["Your interest at most", `${formatUsd(net)}${usd > 0n ? ` (${formatBps(net * 10000n / usd)})` : ""}`],
      ]} />
      <p className="hint">
        If less is drawn or the contractor repays early, you earn interest only on the money used, for the days it was used,
        and your share of any undrawn money comes back to you. Interest is paid every 30 days from launch, in {symbol} at that day's price;
        your principal comes back as the {symbol} you deposited. Swapping {symbol} to XTZ on the exchange has its own fee.
      </p>
    </>;
  }

  // Statement after launch (live while open, final once settled), laid out
  // like the estimate.
  function renderStatement(p: Project, inv: Investment, now: bigint) {
    const settled = p.status === "Repaid" || p.status === "Defaulted";
    const drawn = drawnUsd(p);
    const firstDraw = p.milestones.reduce<bigint | null>((first, ms) => ms.drawnAt !== null && (first === null || ms.drawnAt < first) ? ms.drawnAt : first, null);
    const paidInterest = p.holdUsedUsd + p.interestPaidUsd;
    const earned = settled ? paidInterest : interestAt(p, now);
    const fee = builderShare(earned, p.builderShareBps);
    const undrawnBro = p.milestones.reduce((sum, ms) => sum + (ms.drawnAt === null ? ms.escrowBro : 0n), 0n);
    const drawnBro = p.milestones.reduce((sum, ms) => sum + (ms.drawnAt !== null ? ms.escrowBro : 0n), 0n);
    const usdShare = (amount: bigint) => share(p, amount, inv);
    return <>
      <Lines head={`Your ${formatBps(p.fundedBro > 0n ? inv.bro * 10000n / p.fundedBro : 0n)}`} rows={[
        ["Money used", drawn > 0n ? `${formatUsd(drawn)} drawn${firstDraw !== null ? ` from ${formatTime(firstDraw)}` : ""} (your share ${formatUsd(usdShare(drawn))})` : "nothing drawn yet"],
        [settled ? "Interest earned" : "Interest earned so far", formatUsd(usdShare(earned))],
        [`BRO Builder service fee (${formatBps(p.builderShareBps)})`, `-${formatUsd(usdShare(fee))}`],
        ["Your interest", `${formatUsd(usdShare(earned - fee))}${settled ? "" : ` (${formatUsd(usdShare(paidInterest - builderShare(paidInterest, p.builderShareBps)))} paid out so far)`}`],
        ["Undrawn money returned", p.released ? formatBro(usdShare(undrawnBro)) : hasUndrawn(p) ? "after the end date or at repayment" : "none"],
        ["Principal returned", settled ? formatBro(usdShare(drawnBro)) : "at full repayment"],
        ...(p.uncoveredBro > 0n ? [["Not covered by the funding wallet", formatBro(usdShare(p.uncoveredBro))] as [string, string]] : []),
        ["Claimed so far", formatBro(inv.claimedBro)],
        ["Claimable now", formatBro(claimable(p, inv))],
      ]} />
      {!settled && <p className="hint">Interest so far is estimated from on-chain data up to now; it is paid out from the hold at each 30-day mark, and any interest above the hold when the contractor repays.</p>}
    </>;
  }

  function renderActions(p: Project, sys: System) {
    const now = nowSeconds();
    const deadlinePassed = now > p.fundingDeadline;
    const isContractor = wallet.address === p.contractor;
    const hasInvestment = Boolean(investment && investment.bro > 0n);
    const periodEnded = p.endDate !== null && now > p.endDate;
    const actions: ReactNode[] = [];

    if (p.status === "Funding" && !deadlinePassed) {
      const remainingUsd = p.budgetUsd - p.fundedUsd;
      const remaining = usdToBroUp(remainingUsd, sys.price);
      const entered = parseUnits(investInput, decimals);
      const depositBro = entered && entered > 0n ? (entered < remaining ? entered : remaining) : null;
      const depositUsd = depositBro !== null && sys.price > 0n
        ? (depositBro === remaining ? remainingUsd : depositBro * PRICE_SCALE / sys.price)
        : null;
      actions.push(<Action key="invest" title="Invest" hint={<>
        {stale ? "The market price is stale; ask the oracle to push a fresh price before investing. " : `About ${formatBro(remaining)} fully funds the remaining ${formatUsd(remainingUsd)}. `}
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
        <h4>Estimate, before investing</h4>
        {depositUsd !== null && !stale
          ? renderEstimate(p, depositUsd)
          : <p className="hint">Enter a {symbol} amount to see what it can earn{stale ? " (needs a fresh price)" : ""}. Rate {formatBps(p.monthlyRateBps)} a month for {p.termMonths} month(s); BRO Builder takes {formatBps(p.builderShareBps)} of your interest.</p>}
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
        BROProjects admin or approver NFT holder. "{current.description}" is due {formatTime(current.dueAt)}. Once approved, the contractor can draw its {formatUsd(current.usd)}{periodEnded ? ", but the contract period has ended, so it can no longer be drawn" : ""}. A project more than {sys.graceDays.toString()} grace day(s) past this due date can be defaulted.
      </>}>
        <LoadingButton loading={busy === "approve"} disabled={!wallet.address} onClick={() => void run("approve", "approve_milestone", (toolkit) => contractCall(toolkit, sys.projectsContract, "approve_milestone", p.id.toString()))}>Approve Milestone</LoadingButton>
      </Action>);
    }

    if (p.status === "Active" && isContractor) {
      const drawable = p.milestones.slice(0, p.currentMilestone).filter((milestone) => milestone.drawnAt === null);
      const cents = drawable.reduce((sum, milestone) => sum + milestone.usd, 0n);
      const split = drawSplit(p, cents);
      actions.push(<Action key="draw" title="Draw approved milestones" hint={periodEnded
        ? `The contract period ended on ${formatTime(p.endDate)}; no more draws. Undrawn money goes back to investors.`
        : drawable.length
          ? <>
            {drawable.length} milestone(s) worth {formatUsd(cents)}.
            {split.withheld > 0n ? ` ${formatUsd(split.withheld)} is withheld for the interest hold (${formatUsd(p.holdUsd)} of ${formatUsd(holdTarget(p))} held so far), so you receive ${formatUsd(split.paid)}.` : " The interest hold is complete, so you receive all of it."}
            {stale ? " The price is stale, so drawing will fail until it is refreshed." : ` That is about ${formatBro(usdToBro(split.paid, sys.price))} at today's price.`}
            {" "}Interest at {formatBps(p.monthlyRateBps)} a month ({formatDailyRate(p.monthlyRateBps)} a day, partial days in full) runs on the drawn {formatUsd(cents)} from now until repaid.
            {sys.projectsPaused && " BROProjects is paused."}
          </>
          : "Nothing approved to draw yet."}>
        <LoadingButton loading={busy === "draw"} disabled={!drawable.length || stale || sys.projectsPaused || periodEnded} onClick={() => void run("draw", "claim_milestone", (toolkit) => contractCall(toolkit, sys.projectsContract, "claim_milestone", p.id.toString()))}>Draw</LoadingButton>
      </Action>);
    }

    if (isOpen(p)) {
      const pending = pendingHoldPayout(p, now);
      const next = nextMark(p, now);
      const mark = latestMark(p, now);
      actions.push(<Action key="pay-interest" title="Pay interest (every 30 days)" hint={pending > 0n
        ? <>Anyone. {formatUsd(pending)} of interest earned up to {formatTime(mark)} is due from the hold: {formatUsd(builderShare(pending, p.builderShareBps))} ({formatBps(p.builderShareBps)}) to the funding wallet, the rest to investors{stale ? ". The price is stale; this fails until it is refreshed" : `, about ${formatBro(usdToBro(pending, sys.price))} at today's price`}. Draws and repayments also pay it first.{sys.projectsPaused && " BROProjects is paused."}</>
        : `Nothing due from the hold right now. The next 30-day mark is ${formatTime(next)}.`}>
        <LoadingButton loading={busy === "pay-interest"} disabled={!wallet.address || pending === 0n || stale || sys.projectsPaused} onClick={() => void run("pay-interest", "pay_interest", (toolkit) => contractCall(toolkit, sys.projectsContract, "pay_interest", p.id.toString()))}>Pay Interest</LoadingButton>
      </Action>);
    }

    if (isOpen(p) && hasUndrawn(p) && periodEnded) {
      const undrawn = p.milestones.filter((milestone) => milestone.drawnAt === null);
      actions.push(<Action key="release" title="Return undrawn money to investors" hint={`Anyone. The contract period ended on ${formatTime(p.endDate)}. Hands the ${formatBro(undrawn.reduce((sum, milestone) => sum + milestone.escrowBro, 0n))} escrow of ${undrawn.length} undrawn milestone(s) back to investors, as the ${symbol} they deposited.`}>
        <LoadingButton loading={busy === "release"} disabled={!wallet.address} onClick={() => void run("release", "release_undrawn", (toolkit) => contractCall(toolkit, sys.projectsContract, "release_undrawn", p.id.toString()))}>Release Undrawn</LoadingButton>
      </Action>);
    }

    if (isOpen(p)) {
      const debt = owed(p, sys.graceDays, now);
      const feeFrom = p.endDate !== null ? p.endDate + sys.graceDays * DAY : null;
      const earlyExitLocked = hasUndrawn(p) && !periodEnded && !isContractor;
      actions.push(<Action key="repay" title={p.status === "Active" ? "Repay (any time, early repayment ends the project)" : "Repay"} hint={<>
        Owed now: {formatUsd(debt.principal)} principal + {formatUsd(debt.interest)} interest so far − {formatUsd(p.holdUsd)} hold
        {p.interestPaidUsd > 0n ? ` − ${formatUsd(p.interestPaidUsd)} interest already paid` : ""} = {formatUsd(debt.base)}
        {debt.fee > 0n ? ` + ${formatUsd(debt.fee)} late fee (${formatBps(debt.feeBps)})` : ""} = <strong>{formatUsd(debt.due)}</strong>.{" "}
        Each installment pays the late fee on it first, then interest above the hold, then principal (which stops its interest).
        Paid in {symbol} at the price on the day{stale ? "; the price is stale, so repayment fails until it is refreshed" : `, about ${formatBro(usdToBroUp(debt.due, sys.price))} today`}.{" "}
        {feeFrom === null
          ? "No end date is approved yet, so no late fee applies."
          : debt.feeBps > 0n
            ? `The late fee is ${formatBps(p.lateFeeBpsPerDay)} a day since the end date (max 100%), on what each installment pays.`
            : `Repay by ${formatTime(feeFrom)} to avoid a late fee; after that, every day since the end date ${formatTime(p.endDate)} costs ${formatBps(p.lateFeeBpsPerDay)} of what is paid.`}
        {" "}Interest grows daily, so "Pay all" may leave a few cents if a new day starts first.
        {hasUndrawn(p) && " Paying everything ends the project and returns the undrawn money to investors."}
        {earlyExitLocked && " While undrawn milestones remain and the period is open, only the contractor can make the final payment."}
        {" "}Anyone may pay installments. This batch makes BROProjects an operator of your {symbol}, repays, then removes the operator.{sys.projectsPaused && " BROProjects is paused."}
      </>}>
        {debt.due === 0n
          ? <LoadingButton loading={busy === "repay"} disabled={!wallet.address || stale || sys.projectsPaused || earlyExitLocked} onClick={() => void run("repay", "repay", (toolkit) => contractCall(toolkit, sys.projectsContract, "repay", { project_id: p.id.toString(), usd_cents: "0" }))}>Nothing owed: settle now</LoadingButton>
          : <div className="row">
            <input className="grow" type="number" min="0" step="0.01" value={repayInput} onChange={(event) => setRepayInput(event.target.value)} placeholder="USD amount" />
            <button className="secondary small" onClick={() => setRepayInput(formatUnits(debt.due, 2))}>Pay all</button>
            <LoadingButton loading={busy === "repay"} disabled={!wallet.address || stale || sys.projectsPaused} onClick={() => {
              const cents = parseUnits(repayInput, 2);
              if (!cents || cents <= 0n) {
                log("Enter a positive USD amount with at most 2 decimals.");
                return;
              }
              void run("repay", "repay", (toolkit) => withOperator(toolkit, sys.projectsContract, (projects) => projects.methodsObject.repay({ project_id: p.id.toString(), usd_cents: cents.toString() })));
            }}>Repay</LoadingButton>
          </div>}
      </Action>);
    }

    if (isOpen(p) && isContractor) {
      actions.push(<Action key="propose-end" title="Propose end date" hint={`Contractor only. The end date ends the contract period: no draws after it, undrawn money goes back to investors, and the late fee starts after ${sys.graceDays} grace day(s). The BROProjects admin must approve it; until then ${p.endDate !== null ? `the approved end date ${formatTime(p.endDate)} stays in force` : "no end date applies"}.${p.proposedEndDate !== null ? ` This replaces the pending proposal (${formatTime(p.proposedEndDate)}).` : ""}`}>
        <div className="row">
          <input className="grow" type="datetime-local" value={endDateInput} onChange={(event) => setEndDateInput(event.target.value)} />
          <LoadingButton loading={busy === "propose-end"} onClick={() => {
            const date = new Date(endDateInput);
            if (Number.isNaN(date.getTime())) {
              log("Enter an end date.");
              return;
            }
            void run("propose-end", "propose_end_date", (toolkit) => contractCall(toolkit, sys.projectsContract, "propose_end_date", { project_id: p.id.toString(), end_date: toTimestamp(date) }));
          }}>Propose</LoadingButton>
        </div>
      </Action>);
    }

    if (isOpen(p) && p.proposedEndDate !== null && isProjectsAdmin) {
      const proposed = toTimestamp(new Date(Number(p.proposedEndDate) * 1000));
      actions.push(<Action key="review-end" title="Review proposed end date" hint={`BROProjects admin only. The contractor proposes ${formatTime(p.proposedEndDate)}${p.endDate !== null ? ` (approved now: ${formatTime(p.endDate)})` : ""}. Once approved it ends the contract period; the late fee and default start after it + ${sys.graceDays} grace day(s).${p.proposedEndDate < now ? " This date is in the past, so the period ends immediately." : ""}`}>
        <div className="row">
          <LoadingButton loading={busy === "approve-end"} onClick={() => void run("approve-end", "approve_end_date", (toolkit) => contractCall(toolkit, sys.projectsContract, "approve_end_date", { project_id: p.id.toString(), end_date: proposed }))}>Approve</LoadingButton>
          <LoadingButton className="secondary" loading={busy === "reject-end"} onClick={() => void run("reject-end", "reject_end_date", (toolkit) => contractCall(toolkit, sys.projectsContract, "reject_end_date", p.id.toString()))}>Reject</LoadingButton>
        </div>
      </Action>);
    }

    if (isOpen(p)) {
      const eligibleAt = defaultEligibleAt(p, sys.graceDays);
      actions.push(<Action key="default" title="Mark as defaulted" hint={`BROProjects admin or approver NFT holder. ${eligibleAt !== null
        ? eligibleAt < now ? "This project is overdue and can be defaulted now." : `Possible after ${formatTime(eligibleAt)}.`
        : "Not possible until an end date is approved."} Needs a fresh price. The hold pays the interest earned so far, undrawn money and what's left of the hold go to investors, and the funding wallet tops them up as far as it can. What is owed is recorded but not collected.`}>
        <LoadingButton className="secondary" loading={busy === "default"} disabled={!wallet.address || stale} onClick={() => void run("default", "mark_default", (toolkit) => contractCall(toolkit, sys.projectsContract, "mark_default", p.id.toString()))}>Mark Default</LoadingButton>
      </Action>);
    }

    if (hasInvestment && p.launched) {
      const amount = claimable(p, investment!);
      actions.push(<Action key="payout" title="Claim payout" hint={amount > 0n
        ? `${formatBro(amount)} is yours to claim: interest payouts, returned undrawn money and, once settled, your principal.${sys.projectsPaused ? " BROProjects is paused." : ""}`
        : "Nothing new to claim. Interest is paid every 30 days; undrawn money after the end date; principal at settlement."}>
        <LoadingButton loading={busy === "payout"} disabled={amount === 0n || sys.projectsPaused} onClick={() => void run("payout", "claim_payout", (toolkit) => contractCall(toolkit, sys.projectsContract, "claim_payout", p.id.toString()))}>Claim Payout</LoadingButton>
      </Action>);
    }

    return actions.length ? actions : <p className="hint">No actions available for your wallet at this stage.</p>;
  }

  function projectLines(p: Project, sys: System) {
    const now = nowSeconds();
    const lines = [
      `Status: ${p.status} · ${p.projectType}`,
      `Contractor: ${p.contractor}`,
      `Scope: ${p.scope}`,
      `Site: ${[p.site.street, p.site.city, p.site.state, p.site.zip].filter(Boolean).join(", ") || "—"}`,
      `Owner: ${[p.owner.name, p.owner.phone, p.owner.email].filter(Boolean).join(" · ") || "—"}`,
      `Budget: ${formatUsd(p.budgetUsd)} at ${formatBps(p.monthlyRateBps)} a month on drawn money, term ${p.termMonths} month(s)`,
      `Interest hold: ${formatUsd(holdTarget(p))} (budget × rate × term), withheld from the first draws`,
      `BRO Builder share: ${formatBps(p.builderShareBps)} of investors' interest · late fee ${formatBps(p.lateFeeBpsPerDay)}/day since the end date once grace has passed`,
      `Funded: ${formatUsd(p.fundedUsd)} (${formatBro(p.fundedBro)}), deadline ${formatTime(p.fundingDeadline)}${p.fundedAt !== null ? `, launched ${formatTime(p.fundedAt)}` : ""}`,
      `Est. completion: ${formatTime(p.estCompletion)}`,
    ];
    if (p.launched) {
      const open = isOpen(p);
      const interest = open ? interestAt(p, now) : p.holdUsedUsd + p.interestPaidUsd;
      lines.push(
        `End date (end of the contract period): ${p.endDate !== null ? `${formatTime(p.endDate)}, late fee after ${formatTime(p.endDate + sys.graceDays * DAY)}` : "not approved yet"}${p.proposedEndDate !== null ? `; proposed ${formatTime(p.proposedEndDate)}, waiting for the admin` : ""}`,
        `Drawn: ${formatUsd(drawnUsd(p))} · outstanding principal ${formatUsd(p.milestones.reduce((sum, ms) => sum + ms.outstandingUsd, 0n))}`,
        `Hold: ${formatUsd(p.holdUsd)} withheld (${formatBro(p.holdBro)} left), ${formatUsd(p.holdUsedUsd)} paid out as interest`,
        `${open ? "Interest so far" : "Interest paid"}: ${formatUsd(interest)}${p.interestPaidUsd > 0n ? ` (${formatUsd(p.interestPaidUsd)} above the hold paid by the contractor)` : ""}${open && p.fundedAt !== null ? ` · next 30-day mark ${formatTime(nextMark(p, now))}` : ""}`,
        `Repaid: ${formatUsd(p.repaidUsd)}${p.lateFeeUsd > 0n ? ` incl. ${formatUsd(p.lateFeeUsd)} late fee` : ""} · ${p.status === "Defaulted" ? "owed at default (not collected)" : "due now"}: ${formatUsd(amountDue(p, sys.graceDays, now))}`,
        `Investors: ${formatBro(p.investorBro)} allotted so far${p.released ? " (undrawn money returned)" : ""}${p.uncoveredBro > 0n ? `, ${formatBro(p.uncoveredBro)} not covered` : ""}`,
      );
      if (p.flows) {
        lines.push(`Funding wallet: +${formatBro(p.flows.builderFeeBro)} BRO Builder share, +${formatBro(p.flows.lateFeeBro)} late fees, +${formatBro(p.flows.surplusBro)} price surplus, -${formatBro(p.flows.coveredBro)} covered`);
      }
    }
    lines.push(`Your investment: ${investment ? `${formatUsd(investment.usd)} (${formatBro(investment.bro)})` : wallet.address ? "none" : "connect a wallet"}`);
    return lines.join("\n");
  }

  function milestoneState(p: Project, milestone: Milestone, index: number) {
    if (milestone.drawnAt !== null) {
      return milestone.outstandingUsd === 0n && p.launched && milestone.usd > 0n && !isOpen(p)
        ? <span className="tag ok">drawn, repaid</span>
        : <span className="tag ok">drawn</span>;
    }
    if (p.released) return <span className="tag">returned to investors</span>;
    if (milestone.approvedAt !== null) return <span className="tag warn">approved</span>;
    if (index === p.currentMilestone && p.status === "Active") return <span className="tag warn">current</span>;
    return <span className="tag">pending</span>;
  }

  return <Page wide title="BRO Projects" subtitle="Submit and fund projects on BROFunding, then track draws, daily interest, 30-day interest payouts, repayment and settlement on BROProjects, priced and backed by BROMarketAssistant.">
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
          `BROProjects: ${system.projectsPaused ? "PAUSED" : "running"} · grace ${system.graceDays} day(s)`,
          `BRO Builder share for new projects: ${formatBps(system.builderShareBps)} of investors' interest`,
          `Approver NFT: ${system.nft ? `${system.nft.address} #${system.nft.tokenId}` : "none (BROProjects admin only)"}`,
          `Market: ${system.market}`,
          `Oracle: ${system.oracle}`,
          `Token: ${system.token.symbol} (${system.tokenAddress}, id ${system.tokenId})`,
          `Price: ${system.price > 0n ? `$${usdFromPrice(system.price, decimals)} per ${symbol}` : "not set"}, updated ${system.price > 0n ? new Date(system.priceUpdatedAt).toLocaleString() : "never"}${stale ? "  (STALE)" : ""}`,
          `Funding wallet: ${system.fundingWallet}`,
        ].join("\n")}
      </div>}
    </Section>

    {system && (!fundingLinked || !marketLinked) && <div className="note">
      <strong>Setup incomplete:</strong>{" "}
      {!fundingLinked && "BROFunding is not linked to this BROProjects, so fully funded projects cannot launch. "}
      {!marketLinked && "The market assistant is not linked to this BROProjects, so draws, interest payouts and settlements that need funding-wallet coverage will fail. "}
      <Link to="/deployment-projects-setup">Open the projects setup page &rarr;</Link>
    </div>}

    {system && <Section title="4. Price Feed">
      <Action title="Update BRO/USD price" hint={`Oracle only${isOracle ? "" : " (connect the oracle wallet)"}. Prices older than ${system.maxPriceAge} seconds are rejected by BROFunding and BROProjects.`}>
        <div className="row">
          <input className="grow" type="number" min="0" step="any" value={priceInput} onChange={(event) => setPriceInput(event.target.value)} placeholder={`USD price of 1 ${symbol}, e.g. 0.05`} />
          <LoadingButton loading={busy === "price"} disabled={!isOracle} onClick={updatePrice}>Push Price</LoadingButton>
        </div>
      </Action>
      <p className="hint">Linking, the approver NFT, funding-wallet setup, rules, pausing and admin transfers are on the <Link to="/deployment-projects-setup">projects setup page</Link>.</p>
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
        <label>Estimated completion (proposed end date)<input type="date" value={form.estCompletion} onChange={updateForm("estCompletion")} /></label>
        <label>Budget (USD)<input type="number" min="0" step="0.01" value={form.budget} onChange={updateForm("budget")} placeholder="e.g. 25000" /></label>
        <label>Funding deadline<input type="datetime-local" value={form.fundingDeadline} onChange={updateForm("fundingDeadline")} /></label>
        <label>Monthly interest rate (%)
          <input type="number" value={form.monthlyRate} readOnly placeholder={wallet.address ? "Enter budget and term" : "Connect a wallet"} />
        </label>
        <label>Term (months)<input type="number" min="1" max="60" value={form.termMonths} onChange={updateForm("termMonths")} /></label>
      </div>
      {quoteStatus.loading && <p className="hint">Fetching rate…</p>}
      {quoteStatus.error && <p className="hint">Could not get a rate: {quoteStatus.error}</p>}
      {quote && <div className="info">
        {[
          `Risk: ${quote.riskCategory} (score ${quote.totalScore}/100, ${quote.selfReportedPoints} self-reported)`,
          `Rate: ${quote.monthlyRatePct}% per month (${formRate !== null ? formatDailyRate(formRate) : "—"} per day on drawn money)`,
          ...quote.limitations.map((item) => `• ${item}`),
        ].join("\n")}
      </div>}
      {formRate !== null && (formRate < MIN_RATE_BPS || formRate > MAX_RATE_BPS) && <p className="hint">The quoted rate is outside the 3%–9% a month the contract accepts, so this project can't be listed.</p>}
      {formHold !== null && <div className="note">
        <strong>Interest hold: {formatUsd(formHold)}.</strong> Budget × monthly rate × term is withheld from your first draw(s): your first draw arrives minus this hold (all of it, if the draw is smaller, with the rest taken from the next draws). It pays investors' interest every 30 days, and whatever is unused comes off what you repay. You repay what you drew plus the real interest (charged by the day only on money drawn) minus the hold.
      </div>}
      <p className="hint">The monthly rate is quoted by the BRO rate API for your wallet, budget and term; the contract accepts 3%–9% a month and a term of 1–60 months. The estimated completion is proposed as your end date; once the BROProjects admin approves it, it ends the contract period.</p>

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
      <p className="hint">Each milestone's clock starts when the previous one is approved (the first starts when funding closes). Approved milestones are drawn by the contractor; interest starts on each draw.</p>
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
            <thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Budget</th><th>Rate</th><th>Funded</th><th>Drawn</th><th>Deadline</th><th /></tr></thead>
            <tbody>
              {system.projects.map((item) => <tr key={item.id} className={item.id === selectedId ? "selected" : undefined}>
                <td>{item.id}</td>
                <td>{item.title}{item.contractor === wallet.address && <span className="tag">yours</span>}</td>
                <td><StatusTag status={item.status} /></td>
                <td>{formatUsd(item.budgetUsd)}</td>
                <td>{formatBps(item.monthlyRateBps)}/mo</td>
                <td>{formatBps(item.fundedUsd * 10000n / item.budgetUsd)}</td>
                <td>{item.milestones.filter((ms) => ms.drawnAt !== null).length} / {item.milestones.length}</td>
                <td>{new Date(Number(item.fundingDeadline) * 1000).toLocaleDateString()}</td>
                <td><button className="secondary small" onClick={() => void selectProject(item.id)}>View</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
    </Section>}

    {system && project && <Section title={`7. Project #${project.id}: ${project.title}`}>
      <div className="info">{projectLines(project, system)}</div>

      <h4>Milestones</h4>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Description</th><th>Share</th><th>USD</th><th>Escrow</th><th>Due</th><th>Approved</th><th>Drawn</th><th>Outstanding</th><th>State</th></tr></thead>
          <tbody>
            {project.milestones.map((milestone, index) => <tr key={index}>
              <td>{index + 1}</td>
              <td>{milestone.description}</td>
              <td>{formatBps(milestone.pctBps)}</td>
              <td>{formatUsd(milestone.usd)}</td>
              <td>{formatBro(milestone.escrowBro)}</td>
              <td>{milestone.dueAt !== null ? formatTime(milestone.dueAt) : `${milestone.durationDays} days`}</td>
              <td>{formatTime(milestone.approvedAt)}</td>
              <td>{milestone.drawnAt !== null ? `${formatTime(milestone.drawnAt)} (${ceilDays(nowSeconds() - milestone.drawnAt)} day(s))` : "—"}</td>
              <td>{milestone.drawnAt !== null ? formatUsd(milestone.outstandingUsd) : "—"}</td>
              <td>{milestoneState(project, milestone, index)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>

      {investment && investment.bro > 0n && project.launched && <>
        <h4>{["Repaid", "Defaulted"].includes(project.status) ? "Your statement, after closing" : "Your statement so far"}</h4>
        {renderStatement(project, investment, nowSeconds())}
      </>}

      <h4>Actions</h4>
      {renderActions(project, system)}
    </Section>}

    <Status messages={messages} />
  </Page>;
}
