import { z } from 'zod';
import { nodeEnvSchema } from './schema';

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  RPC_URL_MAINNET: z.string().url(),
  RPC_URL_ARBITRUM: z.string().url(),
  RPC_URL_BASE: z.string().url(),
});

export const ENV = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  RPC_URL_MAINNET: process.env.RPC_URL_MAINNET,
  RPC_URL_ARBITRUM: process.env.RPC_URL_ARBITRUM,
  RPC_URL_BASE: process.env.RPC_URL_BASE,
});
