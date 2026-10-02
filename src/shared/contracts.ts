import { MichelsonMap } from "@taquito/taquito";

export const CONTRACT_CODE_URLS = {
  token: "https://static.eidoriantan.com/contracts/brotoken.tz",
  dex: "https://static.eidoriantan.com/contracts/brodex.tz",
} as const;

export function toHexBytes(value: string) {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

export function createDexStorage(tokenAddress: string, tokenId: number, feeBps: number, admin: string) {
  const metadata = new MichelsonMap();
  metadata.set("", toHexBytes("https://brobuilder.llc/token-metadata-DEX.json"));
  return {
    metadata,
    admin,
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
