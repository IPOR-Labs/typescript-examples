import { parseAbi } from "viem";

// Source: ipor-abi, mainnet/mainnet-base-fusion/abis (PriceOracleMiddlewareUsdImpl at 167cf8f).
export const priceOracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256 assetPrice, uint256 decimals)",
]);
