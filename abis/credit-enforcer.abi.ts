import { parseAbi } from "viem";

// Source: ipor-webapp packages/fusion-sdk/src/markets/reservoir/abi/credit-enforcer.abi.ts at 220fe2a0a.
export const creditEnforcerAbi = parseAbi([
  "function mintStablecoin(uint256 amount) returns (uint256)",
]);
