export type RateQuote = {
  totalRatePct: number;      // total interest for the term, as % of the loan (goes in the form)
  monthlyRatePct: number;
  dailyRatePct: number;
  billableDays: number;
  totalInterestUsd: number;
  totalRepaymentUsd: number;
  riskCategory: string;
  totalScore: number;
  selfReportedPoints: number;
  limitations: string[];
};

const RATE_API = "https://www.brobuilder.llc/api/bro-rate-api.php";
const CF_PROXY = "https://cf-proxy.eidoriantan.com";

function proxied(url: string) {
  return `${CF_PROXY}/?url=${encodeURIComponent(url)}`;
}

export async function fetchRate(
  params: { address: string; loanAmount: number; termDays: number; primo: boolean },
  signal: AbortSignal,
): Promise<RateQuote> {
  const response = await fetch(proxied(RATE_API), {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    headers: { accept: "*/*", "content-type": "application/json" },
    body: JSON.stringify({
      address: params.address,
      loan_amount: params.loanAmount,
      term_days: params.termDays,
      primo: params.primo,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Rate API returned ${response.status}`);

  const data: any = await response.json();
  if (!data.ok) throw new Error(data.error ?? data.message ?? "Rate API rejected the request");

  const loan = Number(data.loan_amount_usd);
  const interest = Number(data.total_interest_usd);
  if (!(loan > 0) || !Number.isFinite(interest) || interest < 0) {
    throw new Error("Rate API response is missing loan_amount_usd or total_interest_usd");
  }

  return {
    totalRatePct: (interest / loan) * 100,
    monthlyRatePct: Number(data.monthly_rate_pct),
    dailyRatePct: Number(data.daily_rate_pct),
    billableDays: Number(data.billable_days),
    totalInterestUsd: interest,
    totalRepaymentUsd: Number(data.total_repayment_usd),
    riskCategory: String(data.risk_category ?? ""),
    totalScore: Number(data.total_score),
    selfReportedPoints: Number(data.self_reported ?? 0),
    limitations: Array.isArray(data.limitations) ? data.limitations : [],
  };
}
