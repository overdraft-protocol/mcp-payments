import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'rails/x402-evm/index': 'src/rails/x402-evm/index.ts',
    'rails/dev-signature/index': 'src/rails/dev-signature/index.ts',
    'rails/stripe/index': 'src/rails/stripe/index.ts',
    'server/payment-log': 'src/server/payment-log.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
