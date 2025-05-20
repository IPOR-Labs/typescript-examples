import { arbitrum, base, mainnet } from 'viem/chains';

const FUSION_CHAINS = [mainnet, arbitrum, base] as const;

export type FusionChain = (typeof FUSION_CHAINS)[number];

export type ChainIdFusion = FusionChain['id'];