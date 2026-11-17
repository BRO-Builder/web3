// Mirrors the BROProjects rules (contracts/broprojects.py). Keep in sync with
// the contract: daily interest on drawn money only, the interest hold, the
// 30-day hold payouts, the amount owed and the late fee.
// Units: USD in cents, BRO in base units, timestamps in seconds.
import { PRICE_SCALE } from "./broProjects";

export const DAY = 86400n;
export const PERIOD = 30n * DAY;

export type RuleMilestone = {
  usd: bigint;
  escrowBro: bigint;
  dueAt: bigint | null;
  drawnAt: bigint | null;
  outstandingUsd: bigint;
};

export type RuleProject = {
  budgetUsd: bigint;
  monthlyRateBps: bigint;
  termMonths: bigint;
  lateFeeBpsPerDay: bigint;
  builderShareBps: bigint;
  fundedAt: bigint | null;
  endDate: bigint | null;
  milestones: RuleMilestone[];
  currentMilestone: number;
  holdUsd: bigint;
  holdUsedUsd: bigint;
  paidUntil: bigint | null;
  closedUsdDays: bigint;
  interestPaidUsd: bigint;
  defaultDueUsd: bigint;
  status: string;
};

export function toSeconds(value: string | null) {
  return value ? BigInt(Math.floor(Date.parse(value) / 1000)) : null;
}

export function nowSeconds() {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function ceilDays(seconds: bigint) {
  return (seconds + DAY - 1n) / DAY;
}

export function usdToBro(cents: bigint, price: bigint) {
  return cents * price / PRICE_SCALE;
}

export function usdToBroUp(cents: bigint, price: bigint) {
  return (cents * price + PRICE_SCALE - 1n) / PRICE_SCALE;
}

// budget x monthly rate x term
export function holdTarget(p: Pick<RuleProject, "budgetUsd" | "monthlyRateBps" | "termMonths">) {
  return p.budgetUsd * p.monthlyRateBps * p.termMonths / 10000n;
}

// Cent-days of drawn principal up to `to`: closed by repayments, plus each
// draw's outstanding cents times the days (rounded up) since it was drawn.
export function usdDays(p: RuleProject, to: bigint) {
  let total = p.closedUsdDays;
  for (const ms of p.milestones) {
    if (ms.drawnAt !== null && to > ms.drawnAt) total += ms.outstandingUsd * ceilDays(to - ms.drawnAt);
  }
  return total;
}

// Interest in cents up to `to`, at monthly rate / 30 per day, rounded down.
export function interestAt(p: RuleProject, to: bigint) {
  return usdDays(p, to) * p.monthlyRateBps / 300000n;
}

// Late fee rate in bps of what is paid: nothing until the approved end date
// + grace has passed; then every day since the end date, capped at 100%.
export function lateBps(p: RuleProject, graceDays: bigint, now: bigint) {
  if (p.endDate === null || now <= p.endDate + graceDays * DAY) return 0n;
  const bps = ceilDays(now - p.endDate) * p.lateFeeBpsPerDay;
  return bps < 10000n ? bps : 10000n;
}

export function outstandingPrincipal(p: RuleProject) {
  return p.milestones.reduce((sum, ms) => sum + ms.outstandingUsd, 0n);
}

export function drawnUsd(p: RuleProject) {
  return p.milestones.reduce((sum, ms) => sum + (ms.drawnAt !== null ? ms.usd : 0n), 0n);
}

// Mirrors `owed`: principal + interest - hold - interest paid above the hold
// (never below 0); `interest` is the part above the hold.
export function owed(p: RuleProject, graceDays: bigint, now: bigint) {
  const interest = interestAt(p, now);
  const extra = interest - p.holdUsd - p.interestPaidUsd;
  const principal = outstandingPrincipal(p);
  const base = principal + extra > 0n ? principal + extra : 0n;
  const feeBps = lateBps(p, graceDays, now);
  const fee = base * feeBps / 10000n;
  return {
    interest,
    principal,
    base,
    aboveHold: extra > 0n ? extra : 0n,
    unusedHold: p.holdUsd > interest ? p.holdUsd - interest : 0n,
    feeBps,
    fee,
    due: base + fee,
  };
}

// Mirrors the `get_amount_due` view.
export function amountDue(p: RuleProject, graceDays: bigint, now: bigint) {
  if (p.status === "Active" || p.status === "Repaying") return owed(p, graceDays, now).due;
  return p.status === "Defaulted" ? p.defaultDueUsd : 0n;
}

// The latest 30-day mark since launch, at or before `now`.
export function latestMark(p: RuleProject, now: bigint) {
  if (p.fundedAt === null || now < p.fundedAt) return null;
  return p.fundedAt + (now - p.fundedAt) / PERIOD * PERIOD;
}

export function nextMark(p: RuleProject, now: bigint) {
  const latest = latestMark(p, now);
  return latest === null ? null : latest + PERIOD;
}

// Mirrors `pay_interest`: cents payable from the hold now (0 when nothing).
export function pendingHoldPayout(p: RuleProject, now: bigint) {
  const mark = latestMark(p, now);
  if (mark === null || p.paidUntil === null || mark <= p.paidUntil) return 0n;
  const earned = interestAt(p, mark);
  const target = earned < p.holdUsd ? earned : p.holdUsd;
  return target > p.holdUsedUsd ? target - p.holdUsedUsd : 0n;
}

// What a draw of `cents` withholds for the hold, and what the contractor gets.
export function drawSplit(p: RuleProject, cents: bigint) {
  const left = holdTarget(p) - p.holdUsd;
  const withheld = cents < left ? cents : (left > 0n ? left : 0n);
  return { withheld, paid: cents - withheld };
}

// BRO Builder's share of an interest amount (rounded down, like the contract).
export function builderShare(amount: bigint, shareBps: bigint) {
  return amount * shareBps / 10000n;
}

// Mirrors `mark_default`: after the approved end date + grace, or (while
// Active) after the current milestone's due date + grace. Seconds; strictly
// after the returned time.
export function defaultEligibleAt(p: RuleProject, graceDays: bigint) {
  const grace = graceDays * DAY;
  let at: bigint | null = p.endDate !== null ? p.endDate + grace : null;
  const due = p.status === "Active" ? p.milestones[p.currentMilestone]?.dueAt ?? null : null;
  if (due !== null && (at === null || due + grace < at)) at = due + grace;
  return at;
}
