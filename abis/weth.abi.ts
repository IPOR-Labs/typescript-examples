import { parseAbi } from "viem";

// Source: WETH9 deposit(), as used by ipor-webapp packages/fusion-sdk/src/markets/weth at 220fe2a0a.
export const wethAbi = parseAbi([
  "function deposit() payable",
]);
