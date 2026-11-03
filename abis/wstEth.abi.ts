import { parseAbi } from "viem";

// Source: ipor-webapp packages/fusion-sdk/src/markets/lido/abi/wsteth.abi.ts at 220fe2a0a.
export const wstEthAbi = parseAbi([
  "function unwrap(uint256 wstETHAmount) returns (uint256)",
  "function stEthPerToken() view returns (uint256)",
]);
