export function toBigInt(value: { toFixed(): string }) {
  return BigInt(value.toFixed());
}

export function formatUnits(value: bigint, decimals: number) {
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${value / base}.${fraction}` : (value / base).toString();
}

export function parseUnits(value: string, decimals: number) {
  if (!/^\d*\.?\d*$/.test(value) || !value || value === ".") return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}
