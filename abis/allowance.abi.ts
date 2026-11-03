import { parseAbi } from "viem";

// Source: ipor-webapp packages/fusion-sdk/src/abi/zap-in-allowance.abi.ts at 220fe2a0a.
export const allowanceAbi = parseAbi([
  "function transferApprovedAssets(address asset, uint256 amount)",
]);
