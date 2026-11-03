import { parseAbi } from "viem";

// Source: ipor-webapp packages/fusion-sdk/src/markets/lido (stETH submit) at 220fe2a0a.
export const stEthAbi = parseAbi([
  "function submit(address referral) payable returns (uint256)",
]);
