import { parseAbi } from "viem";

// Source: ipor-abi, mainnet/mainnet-base-fusion/abis (IporFusionFactoryImpl at 55b2d9e) and mainnet/mainnet-ethereum-fusion/abis. Every ABI in this folder is the union of the items the stories use.
export const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "error InvalidUnderlyingToken()",
  "error InvalidOwner()",
  "error DaoFeePackageIndexOutOfBounds(uint256 index, uint256 length)",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
