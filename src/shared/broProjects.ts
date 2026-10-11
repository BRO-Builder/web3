import { formatUnits, parseUnits } from "./units";

// Units used by BROFunding / BROProjects / BROMarketAssistant:
// - USD amounts are nat cents
// - price is BRO base units per USD cent, times 10^6
export const PRICE_SCALE = 1_000_000n;

export function readOption<T>(value: T | { Some: T } | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "Some" in value) return value.Some;
  return value;
}

// USD per 1 BRO <-> on-chain price
export function priceFromUsd(usdPerBro: string, decimals: number) {
  const usdE8 = parseUnits(usdPerBro, 8);
  if (!usdE8 || usdE8 <= 0n) return null;
  return 10n ** BigInt(decimals + 12) / usdE8;
}

export function usdFromPrice(price: bigint, decimals: number) {
  return price > 0n ? formatUnits(10n ** BigInt(decimals + 12) / price, 8) : "—";
}

export function isPriceStale(price: bigint, updatedAt: string, maxAgeSeconds: bigint) {
  const age = (Date.now() - Date.parse(updatedAt)) / 1000;
  return price === 0n || age > Number(maxAgeSeconds);
}

export async function fetchTokenBalance(apiUrl: string, account: string, tokenAddress: string, tokenId: string) {
  const query = new URLSearchParams({
    account,
    "token.contract": tokenAddress,
    "token.tokenId": tokenId,
    limit: "1",
  });
  const response = await fetch(`${apiUrl}/v1/tokens/balances?${query}`);
  if (!response.ok) return null;
  const [entry] = await response.json();
  return BigInt(entry?.balance ?? "0");
}
