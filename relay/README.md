# Chronos relay

Cloudflare Worker + Durable Object that lets remote senders wake Chronos jobs **without opening
any inbound port on the Mac**. The daemon dials *out* over WebSocket; the Durable Object buffers
triggers durably and pushes them when the daemon is connected.

```
remote sender ──POST /t/:jobId──▶ Worker ──▶ Durable Object (queue, nonce dedup)
                                                  ▲  outbound WSS  │ push
                                          chronosd relay-client ───┘ ──▶ dispatch + ACK
```

## Endpoints

| route | auth | purpose |
|---|---|---|
| `POST /t/:jobId` | `Authorization: Bearer <INGRESS_TOKEN>` (+ optional HMAC `X-Signature`, `X-Nonce`) | enqueue a trigger; `:jobId` is a job **name** or id/prefix |
| `GET /ws` | `Authorization: Bearer <AGENT_TOKEN>` | the daemon's persistent connection |
| `GET /health` | none | liveness |

## Deploy

```bash
cd relay
npm install
npx wrangler login                       # one-time, your Cloudflare account
npx wrangler secret put AGENT_TOKEN      # daemon ↔ relay
npx wrangler secret put INGRESS_TOKEN    # remote senders → relay
npx wrangler secret put INGRESS_SECRET   # optional: enables HMAC body signatures
npm run deploy                           # -> https://chronos-relay.<subdomain>.workers.dev
```

Then point the daemon at it (e.g. in the launchd plist or shell env):

```bash
CHRONOS_RELAY_URL=wss://chronos-relay.<subdomain>.workers.dev/ws \
CHRONOS_RELAY_TOKEN=<AGENT_TOKEN> \
  npm run dev
```

## Fire a trigger from anywhere

```bash
curl -X POST https://chronos-relay.<subdomain>.workers.dev/t/nightly-report \
  -H "Authorization: Bearer $INGRESS_TOKEN" \
  -H "X-Nonce: $(uuidgen)" \
  -d '{"reason":"manual remote kick"}'
```

With HMAC enabled, also send `X-Signature: <hex hmac-sha256(INGRESS_SECRET, raw-body)>`.

## Verified locally (`wrangler dev`)

- ✅ live delivery (`buffered:false`) and dispatch on the daemon
- ✅ replay protection — repeated `X-Nonce` → `{dedup:true}`, no duplicate run
- ✅ nonce TTL — nonces expire after 1h (alarm purge); timestamps outside the window → `400 stale`
- ✅ constant-time bearer + HMAC verify (no early-exit string compares on secrets)
- ✅ auth — wrong bearer → `401`
- ✅ offline buffering — trigger while daemon down → `{buffered:true}` → delivered on reconnect

## Multi-machine (later)

One Durable Object instance per `MACHINE_ID` (set in `wrangler.jsonc`). Route triggers to a
specific Mac by giving each its own id and token.
