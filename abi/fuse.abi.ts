import { Abi } from "viem";

export const fuseAbi = [
  {
    inputs: [],
    name: 'MARKET_ID',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const satisfies Abi;