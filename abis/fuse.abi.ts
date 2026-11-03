import { parseAbi } from "viem";

export const fuseAbi = parseAbi([
  "function MARKET_ID() view returns (uint256)",
]);
