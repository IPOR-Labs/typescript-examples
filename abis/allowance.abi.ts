import { parseAbi } from "viem";

export const allowanceAbi = parseAbi([
  "function transferApprovedAssets(address asset, uint256 amount)",
]);
