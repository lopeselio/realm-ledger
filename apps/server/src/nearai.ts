import { randomBytes } from 'node:crypto';
import type { SignedReply } from '@realm-ledger/verify';
import { config } from './config.ts';

// NEAR AI Cloud client. Every reply comes back with the exact request and response
// bytes and the TEE's signature over their hashes, so anyone can check it later.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const headers = (): Record<string, string> => ({
  authorization: `Bearer ${config.nearAi.apiKey}`,
  'content-type': 'application/json',
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const nearAiEnabled = (): boolean => config.nearAi.apiKey.length > 0;

/** One chat completion plus its TEE signature. */
export async function signedChat(
  messages: ChatMessage[],
  meta: { realm: number; season: number },
  maxTokens = 220,
): Promise<{ text: string; reply: SignedReply }> {
  const model = config.nearAi.model;
  // the exact bytes we send are what the TEE hashes; keep them
  const request = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.8,
    chat_template_kwargs: { enable_thinking: false },
  });
  const res = await fetch(`${config.nearAi.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: request });
  const response = await res.text();
  if (!res.ok) throw new Error(`NEAR AI chat failed: HTTP ${res.status} ${response.slice(0, 200)}`);
  const body = JSON.parse(response) as { id: string; choices: { message: { content: string | null } }[] };
  const text = (body.choices[0]?.message.content ?? '').trim();

  // the signature can take a moment to become available
  let sig: { text?: string; signature?: string; signing_address?: string; signature_kind?: string } = {};
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(
      `${config.nearAi.baseUrl}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`,
      { headers: headers() },
    );
    if (r.ok) {
      sig = (await r.json()) as typeof sig;
      if (sig.signature) break;
    }
    await sleep(400 * (attempt + 1));
  }
  if (!sig.signature || !sig.text || !sig.signing_address) throw new Error('NEAR AI returned no signature for the reply');
  return {
    text,
    reply: {
      ...meta,
      model,
      request,
      response,
      text: sig.text,
      signature: sig.signature,
      signingAddress: sig.signing_address,
      signatureKind: sig.signature_kind ?? 'unknown',
    },
  };
}

/** The model's attestation report, bound to a fresh nonce. */
export async function attestationReport(): Promise<{ nonce: string; model: string; report: Record<string, unknown> }> {
  const nonce = randomBytes(32).toString('hex');
  const model = config.nearAi.model;
  const url = `${config.nearAi.baseUrl}/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetch(url, { headers: { ...headers(), 'x-no-aliasing': 'true' } });
  if (!res.ok) throw new Error(`attestation report: HTTP ${res.status}`);
  return { nonce, model, report: (await res.json()) as Record<string, unknown> };
}
