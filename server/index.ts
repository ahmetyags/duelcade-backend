import { createGameServer } from './app';
import { createRuntimeFromEnvironment } from './runtime';

const port = Number(process.env.PORT ?? 2567);

async function start(): Promise<void> {
  const runtime = await createRuntimeFromEnvironment();
  const server = createGameServer(runtime);

  await server.listen(port);
  console.log(`[server] Duelcade listening on port ${port}`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void runtime.store?.close();
    });
  }
}

start()
  .catch((error: unknown) => {
    console.error('[server] Failed to start', error);
    process.exitCode = 1;
  });
