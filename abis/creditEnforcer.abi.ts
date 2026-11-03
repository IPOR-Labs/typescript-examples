import { parseAbi } from "viem";

export const creditEnforcerAbi = parseAbi([
  "function mintStablecoin(uint256 amount) returns (uint256)",
]);
