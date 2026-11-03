import { parseAbi } from "viem";

// Source: ipor-fusion, contracts/vaults/extensions/ReferralPlasmaVault.sol at 004d054, which ipor-abi does not publish for Base.
export const referralAbi = parseAbi([
  "function deposit(address vault, uint256 assets, address receiver, bytes32 referralCode) returns (uint256)",
  "event ReferralEvent(address indexed referrer, bytes32 referralCode)",
  "error AccessManagedUnauthorized(address caller)",
]);
