import { parseAbi } from "viem";

// From ipor-abi: mainnet/mainnet-base/abis/pretty/IporPlasmaVaultFeeManagerWstETH.abi.sol at 59444e2 (functions and RecipientFee).
// The fee errors come from mainnet/mainnet-base-fusion/abis/pretty/PlasmaVaultBase.abi.sol at b942366 (raised by the vault and bubbled up).
export const feeManagerAbi = parseAbi([
  "function setDepositFee(uint256 fee)",
  "function getDepositFee() view returns (uint256)",
  "function calculateDepositFee(uint256 shares) view returns (uint256)",
  "error InvalidDepositFee(uint256 fee)",
  "error AccessManagedUnauthorized(address caller)",
  "struct RecipientFee { address recipient; uint256 feeValue; }",
  "function updateManagementFee(RecipientFee[] recipientFees)",
  "function updatePerformanceFee(RecipientFee[] recipientFees)",
  "function getTotalManagementFee() view returns (uint256)",
  "function getTotalPerformanceFee() view returns (uint256)",
  "function getIporDaoFeeRecipientAddress() view returns (address)",
  "function harvestAllFees()",
  "function MANAGEMENT_FEE_ACCOUNT() view returns (address)",
  "function PERFORMANCE_FEE_ACCOUNT() view returns (address)",
  "error InvalidManagementFee(uint256 feeInPercentage)",
  "error InvalidPerformanceFee(uint256 feeInPercentage)",
]);
