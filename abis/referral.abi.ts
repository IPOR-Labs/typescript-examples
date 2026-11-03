import { parseAbi } from "viem";

export const referralAbi = parseAbi([
  "function deposit(address vault, uint256 assets, address receiver, bytes32 referralCode) returns (uint256)",
  "event ReferralEvent(address indexed referrer, bytes32 referralCode)",
  "error AccessManagedUnauthorized(address caller)",
]);
