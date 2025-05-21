import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getPriceOracleMiddleware } from './get-price-oracle-middleware';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getPriceOracleMiddleware', () => {
  it('should get price oracle middleware of the vault', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);

    const priceOracleMiddleware = await getPriceOracleMiddleware(publicClient, {
      plasmaVault,
    });

    expect(priceOracleMiddleware).toBe('0xC9F32d65a278b012371858fD3cdE315B12d664c6');
  }, 30_000);
});