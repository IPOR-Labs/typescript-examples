import { parseAbi } from "viem";

export const priceOracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256 assetPrice, uint256 decimals)",
]);
