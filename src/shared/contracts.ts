import { MichelsonMap } from "@taquito/taquito";

export const CONTRACT_CODE_URLS = {
  token: "https://static.eidoriantan.com/contracts/brotoken.tz",
  dex: "https://static.eidoriantan.com/contracts/brodex.tz",
  delegator: "https://static.eidoriantan.com/contracts/brodelegator.tz",
  market: "https://static.eidoriantan.com/contracts/bromarket.tz",
  funding: "https://static.eidoriantan.com/contracts/brofunding.tz",
  projects: "https://static.eidoriantan.com/contracts/broprojects.tz",
} as const;

export function toHexBytes(value: string) {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Beacon errors implement Error without extending it, and wallets attach the
// useful details (e.g. RPC errors) as extra fields, so read those too.
export function getErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return String(error);
  const details = error as Record<string, any>;
  const parts = [details.title, details.message, details.description]
    .filter((part, index, all): part is string => typeof part === "string" && part !== "" && all.indexOf(part) === index);
  const data = details.fullDescription?.data ?? details.data ?? details.errorData ?? details.errors ?? details.body;
  if (data) parts.push(typeof data === "string" ? data : JSON.stringify(data));
  const message = parts.join(" - ") || JSON.stringify(error);
  return message.length > 2000 ? `${message.slice(0, 2000)}...` : message;
}

export function createTokenStorage(address: string, values: {
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
  description?: string;
  thumbnail?: string;
}) {
  const tokenInfo = new MichelsonMap();
  tokenInfo.set("name", toHexBytes(values.name));
  tokenInfo.set("symbol", toHexBytes(values.symbol));
  tokenInfo.set("decimals", toHexBytes(String(values.decimals)));
  tokenInfo.set("shouldPreferSymbol", toHexBytes("true"));
  if (values.description) tokenInfo.set("description", toHexBytes(values.description));
  if (values.thumbnail) tokenInfo.set("thumbnailUri", toHexBytes(values.thumbnail));

  const tokenMetadata = new MichelsonMap();
  tokenMetadata.set(0, { token_id: 0, token_info: tokenInfo });
  const ledger = new MichelsonMap();
  ledger.set({ 0: address, 1: 0 }, values.supply.toString());
  const supply = new MichelsonMap();
  supply.set(0, values.supply.toString());
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-BRO.json"));

  return { ledger, metadata, next_token_id: 1, operators: new MichelsonMap(), supply, token_metadata: tokenMetadata };
}

export function createDelegatorStorage(admin: string, quorumBps: number) {
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-DELEGATOR.json"));

  const shares = new MichelsonMap();
  const votes = new MichelsonMap();
  const tally = new MichelsonMap();
  return {
    metadata,
    admin,
    dex: null,
    quorum_bps: quorumBps,
    accounted: 0,
    total_shares: 0,
    shares,
    votes,
    tally,
    delegate: null,
  };
}

export function createDexStorage(
  tokenAddress: string,
  tokenId: number,
  feeBps: number,
  vault: string,
  admin: string,
) {
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-DEX.json"));
  return {
    metadata,
    admin,
    vault,
    fee_bps: feeBps,
    paused: false,
    shares: new MichelsonMap(),
    token_address: tokenAddress,
    token_id: tokenId,
    token_pool: 0,
    total_shares: 0,
    xtz_pool: 0,
  };
}

export function createMarketStorage(values: {
  admin: string;
  oracle: string;
  dex: string;
  tokenAddress: string;
  tokenId: number;
  maxPriceAge: number;
}) {
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-MARKET.json"));
  return {
    metadata,
    admin: values.admin,
    oracle: values.oracle,
    ledger: null,
    dex: values.dex,
    token_address: values.tokenAddress,
    token_id: values.tokenId,
    price: 0,
    price_updated_at: "1970-01-01T00:00:00Z",
    max_price_age: values.maxPriceAge,
  };
}

export function createFundingStorage(values: {
  admin: string;
  market: string;
  tokenAddress: string;
  tokenId: number;
  lateFeeBpsPerDay: number;
  maxMilestones: number;
}) {
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-FUNDING.json"));
  return {
    metadata,
    admin: values.admin,
    paused: false,
    market: values.market,
    projects_contract: null,
    token_address: values.tokenAddress,
    token_id: values.tokenId,
    late_fee_bps_per_day: values.lateFeeBpsPerDay,
    max_milestones: values.maxMilestones,
    next_project_id: 0,
    projects: new MichelsonMap(),
    investments: new MichelsonMap(),
  };
}

export function createProjectsStorage(values: {
  admin: string;
  funding: string;
  market: string;
  tokenAddress: string;
  tokenId: number;
  graceDays: number;
}) {
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-PROJECTS.json"));
  return {
    metadata,
    admin: values.admin,
    paused: false,
    funding: values.funding,
    market: values.market,
    token_address: values.tokenAddress,
    token_id: values.tokenId,
    nft: null,
    grace_days: values.graceDays,
    projects: new MichelsonMap(),
    payouts_claimed: new MichelsonMap(),
  };
}
