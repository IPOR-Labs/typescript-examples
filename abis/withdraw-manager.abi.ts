import { parseAbi } from "viem";

// Source: ipor-abi, mainnet/mainnet-base-fusion/abis (IporFusionWithdrawManagerBase at 55b2d9e).
export const withdrawManagerAbi = parseAbi([
  "function getWithdrawWindow() view returns (uint256)",
  "function getPlasmaVaultAddress() view returns (address)",
  "function getSharesToRelease() view returns (uint256)",
  "function getWithdrawFee() view returns (uint256)",
  "function updateWithdrawFee(uint256 fee)",
  "error WithdrawManagerInvalidFee(uint256 fee)",
  "struct WithdrawRequestInfo { uint256 shares; uint256 endWithdrawWindowTimestamp; bool canWithdraw; uint256 withdrawWindowInSeconds; }",
  "function requestShares(uint256 shares)",
  "function releaseFunds(uint256 timestamp, uint256 sharesToRelease)",
  "function requestInfo(address account) view returns (WithdrawRequestInfo)",
  "function getRequestFee() view returns (uint256)",
  "function updateRequestFee(uint256 fee)",
  "error WithdrawManagerInvalidTimestamp(uint256 timestamp)",
  "error WithdrawManagerZeroShares()",
]);
