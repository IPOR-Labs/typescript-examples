import { parseAbi } from "viem";

// Source: ipor-webapp packages/fusion-sdk/src/abi/fuse.abi.ts at 220fe2a0a.
export const fuseAbi = parseAbi([
  "function MARKET_ID() view returns (uint256)",
]);
