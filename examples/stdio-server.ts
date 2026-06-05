/**
 * Minimal runnable MCP server with a paid tool, using the zero-dependency
 * dev-signature rail — no chain, no keys, no network.
 *
 * Two ways to run it:
 *
 *   # 1. As a real stdio MCP server (connect with any MCP client / inspector):
 *   npx tsx examples/stdio-server.ts
 *   #    e.g.  npx @modelcontextprotocol/inspector tsx examples/stdio-server.ts
 *
 *   # 2. Self-contained demo — drives itself in-process and prints the whole
 *   #    challenge → sign → pay → receipt loop:
 *   npx tsx examples/stdio-server.ts --demo
 *
 * The paid tool `buy_widget` costs 1.00 USDC. Payment uses the dev-signature
 * rail: the "wallet" HMACs the offer with a shared secret (here a constant) and
 * sends it back. Swap in createX402EvmRail / createStripeRail (with their
 * settlement strategies) for real money — the wiring is identical.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPaymentExtension, InMemoryChallengeStore, consolePaymentLogger } from '../src/index.js';
import {
  createDevSignatureRail,
  devSignatureSettlement,
  signDevAuthorization,
  RAIL_ID,
} from '../src/rails/dev-signature/index.js';
import { META_KEYS } from '../src/protocol/meta.js';
import type { RailOffer } from '../src/protocol/schema.js';

const DEV_SECRET = 'example-shared-secret';

function buildServer(): McpServer {
  const rail = createDevSignatureRail({ secret: DEV_SECRET });
  const withPayment = createPaymentExtension({
    rails: [rail],
    store: new InMemoryChallengeStore(),
    settlement: devSignatureSettlement,
    logger: consolePaymentLogger,
  });

  const server = new McpServer({ name: 'mpx-example', version: '1.0.0' });

  server.registerTool(
    'buy_widget',
    {
      description: 'Buy a widget for 1.00 USDC. Call without payment to get a challenge.',
      inputSchema: {
        color: z.string().optional(),
        // Argument channel for agents whose host can't write params._meta.
        payment_authorization: z.string().optional().describe(rail.authorizationArgDescription),
      },
    },
    withPayment(
      {
        tool: 'buy_widget',
        description: 'Widget purchase',
        intent: () => ({
          amount: { value: '1.00', currency: 'USDC', decimals: 6 },
          payTo: 'seller-account',
          binding: { kind: 'widget' },
        }),
      },
      async (args, extra) => {
        await extra.settle(); // funds "move" here (no-op for the dev rail)
        const color = (args.color as string) ?? 'blue';
        return { content: [{ type: 'text', text: `Sold one ${color} widget. Thanks!` }] };
      },
    ),
  );

  return server;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // Server now speaks MCP over stdio; logs go to stderr via consolePaymentLogger.
}

async function runDemo(): Promise<void> {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'demo-client', version: '1.0.0' });
  await client.connect(clientTransport);

  console.log('\n1. calling buy_widget with no payment → expect a challenge');
  const challengeRes = await client.callTool({ name: 'buy_widget', arguments: { color: 'red' } });
  const challenge = (challengeRes._meta as Record<string, unknown>)[META_KEYS.challenge] as {
    paymentRequestId: string;
    accepts: RailOffer[];
  };
  const offer = challenge.accepts.find(a => a.rail === RAIL_ID)!;
  console.log(`   got challenge ${challenge.paymentRequestId} for ${challenge.accepts[0].rail}`);

  console.log('2. wallet signs the offer (HMAC) and we retry');
  const { signature } = signDevAuthorization(DEV_SECRET, offer);
  const paidRes = await client.callTool({
    name: 'buy_widget',
    arguments: {
      color: 'red',
      payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, signature }),
    },
  });

  console.log('3. result:');
  for (const c of paidRes.content as { type: string; text?: string }[]) {
    if (c.type === 'text') console.log('   ', c.text);
  }
  const receipt = (paidRes._meta as Record<string, unknown> | undefined)?.[META_KEYS.receipt];
  console.log('   receipt:', JSON.stringify(receipt));

  await client.close();
  await server.close();
}

const main = process.argv.includes('--demo') ? runDemo : runStdio;
main().catch(err => { console.error(err); process.exit(1); });
