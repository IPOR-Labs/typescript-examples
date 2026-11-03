import { parseAbi } from "viem";

export const wethAbi = parseAbi([
  "function deposit() payable",
]);
