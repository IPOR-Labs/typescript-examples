import { parseAbi } from "viem";

export const stEthAbi = parseAbi([
  "function submit(address referral) payable returns (uint256)",
]);
