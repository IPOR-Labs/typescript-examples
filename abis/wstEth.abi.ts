import { parseAbi } from "viem";

export const wstEthAbi = parseAbi([
  "function unwrap(uint256 wstETHAmount) returns (uint256)",
  "function stEthPerToken() view returns (uint256)",
]);
