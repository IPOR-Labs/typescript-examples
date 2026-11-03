import { parseAbi } from "viem";

export const erc4626SupplyFuseAbi = parseAbi([
  "struct Enter { address vault; uint256 vaultAssetAmount; uint256 minSharesOut; }",
  "struct Exit { address vault; uint256 vaultAssetAmount; uint256 maxSharesBurned; }",
  "function enter(Enter data)",
  "function exit(Exit data)",
]);
