import { parseAbi } from "viem";

// Source: ipor-fusion, contracts/fuses/erc4626/Erc4626SupplyFuse.sol at 004d054 (enter and exit structs).
export const erc4626SupplyFuseAbi = parseAbi([
  "struct Enter { address vault; uint256 vaultAssetAmount; uint256 minSharesOut; }",
  "struct Exit { address vault; uint256 vaultAssetAmount; uint256 maxSharesBurned; }",
  "function enter(Enter data)",
  "function exit(Exit data)",
]);
