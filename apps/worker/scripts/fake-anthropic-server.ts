/**
 * A well-behaved local stand-in for the Anthropic API, for demos and manual testing without a key:
 *   pnpm --filter @ledgerline/worker fake-anthropic   (prints the URL to use as ANTHROPIC_BASE_URL)
 */
import { startFakeAnthropic } from "./fake-anthropic.js";

const fake = await startFakeAnthropic({
  rate429: Number(process.env.FAKE_RATE_429 ?? 0),
  badJson: 0,
  badSchema: 0,
  port: Number(process.env.FAKE_PORT ?? 4010),
});
console.log(JSON.stringify({ msg: "fake anthropic listening", url: fake.url }));
