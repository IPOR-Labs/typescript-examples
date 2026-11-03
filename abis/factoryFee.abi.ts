import { parseAbi } from "viem";

// Written by hand: ipor-abi's Base folder has no getDaoFeePackages. Source: ipor-fusion, contracts/factory/FusionFactory.sol (getDaoFeePackages)
// and contracts/factory/lib/FusionFactoryStorageLib.sol (FeePackage), both at 004d054.
export const factoryFeeAbi = parseAbi([
  "struct FeePackage { uint256 managementFee; uint256 performanceFee; address feeRecipient; }",
  "function getDaoFeePackages() view returns (FeePackage[])",
]);
