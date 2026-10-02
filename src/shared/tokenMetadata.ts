export type TokenMetadata = {
  symbol: string;
  decimals: number;
};

export async function fetchTokenMetadata(
  apiUrl: string,
  tokenAddress: string,
  tokenId: string,
): Promise<TokenMetadata> {
  const query = new URLSearchParams({
    contract: tokenAddress,
    tokenId,
    limit: "1",
  });
  const response = await fetch(`${apiUrl}/v1/tokens?${query}`);

  if (!response.ok) {
    throw new Error(`Token metadata request failed (HTTP ${response.status}).`);
  }

  const [token] = await response.json();
  const metadata = token?.metadata ?? {};
  const decimals = Number(metadata.decimals);

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("The token contract does not expose a valid decimals value.");
  }

  return {
    symbol: typeof metadata.symbol === "string" && metadata.symbol
      ? metadata.symbol
      : "TOKEN",
    decimals,
  };
}