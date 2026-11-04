import { parseAbi } from "viem";

// Source: ipor-fusion, contracts/fuses/morpho/MorphoSupplyFuse.sol at 004d054 (enter and exit structs).
export const morphoSupplyFuseAbi = parseAbi([
  "struct MorphoSupplyFuseEnterData { bytes32 morphoMarketId; uint256 amount; }",
  "struct MorphoSupplyFuseExitData { bytes32 morphoMarketId; uint256 amount; }",
  "function enter(MorphoSupplyFuseEnterData data)",
  "function exit(MorphoSupplyFuseExitData data)",
]);
