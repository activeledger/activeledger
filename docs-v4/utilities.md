# `utilities`

`@activeledger/activeutilities` (`packages/utilities/src/`) is where the `v4.1` merge's serialization, compression, and HTTP-client code ended up — mostly already covered piecemeal elsewhere in this doc set (`ActiveRequest`'s keep-alive/gzip-threshold behaviour in [transport.md](transport.md) and [httpd.md](httpd.md), `ActiveClone`'s role in [storage.md](storage.md)). This consolidates what's here and adds two things not covered anywhere else: `ActiveClone`'s full deserialization fallback chain, and a genuine piece of dead code in the P2P client found by reading it end-to-end.

## `ActiveGZip`

Two lines of substance: `promisify(zlib.gzip)` and `promisify(zlib.gunzip)`, exposed as `ActiveGZip.gzip`/`ActiveGZip.ungzip`. Every other gzip-related behaviour documented elsewhere (the 1KB compression threshold in `ActiveRequest.send()`, the always-compress choice in the P2P client) is a decision made by the *caller*, not by this class — this is just the promisified primitive.

## `ActiveRequest`

The undici-based HTTP client used for inter-node HTTP calls. One static method, `send()`. Its two `v4.1`-era tuning details (30-second keep-alive, skip gzip under 1KB) are covered in [transport.md](transport.md#http-default) — not repeated here.

## `ActiveClone`: three-tier deserialization, and why that matters for the storage migration

Covered in [storage.md](storage.md) for its role backing `LevelMe`; the detail worth adding here is *how* `deserialize()` (`clone.ts`) actually works, because it explains something storage.md doesn't: why documents written before this serializer existed still read back correctly with no migration step.

`serialize()` writes MessagePack (via `msgpackr`), prefixed with one flag byte (`0x00` uncompressed, `0x01` gzip'd — gzip only kicks in above `COMPRESSION_THRESHOLD`, 2048 bytes). `deserialize()` tries, in order:

1. **Node's native V8 structured-clone format** — detected by a leading `0xff` signature byte.
2. **The flagged MessagePack format** described above — unflag, optionally gunzip, unpack.
3. **Plain `JSON.parse()`** — the fallback, for anything that doesn't match either binary signature.

That third tier is what makes this a safe drop-in over the codebase's old `JSON.stringify`/`JSON.parse` storage convention: any document written before the `v4.1` MessagePack switch is still just JSON bytes sitting in the store, and `deserialize()` reads those correctly by falling through to step 3, with no explicit migration required. This is a separate mechanism from — but works alongside — the raw/resolved rev-tree backwards-compatibility handling in [storage.md](storage.md#raw-vs-resolved-documents-and-why-the-cache-has-two-keys-per-document); that one handles an old *document shape*, this one handles an old *byte encoding*. A document can need either, both, or neither kind of compatibility handling depending on how old it is.

`ActiveClone.clone(obj)` (deep clone, no serialization format involved) is a different code path — Node's built-in `v8.serialize`/`v8.deserialize` round-trip, used for fast in-memory deep copies. Don't confuse it with `serialize()`/`deserialize()`, which are for storage and wire transport.

## `ActiveFrame`: correct in design, but its counterpart in the P2P client is dead code

`ActiveFrame.read(chunks, bufferLength)` (`frame.ts`) is a small, generic length-prefixed-message reader: given accumulated TCP chunks, it reads a 4-byte big-endian length, and if a full message is available, returns `{ item, remaining, consumed }` so the caller can keep processing however many complete messages have arrived in one `data` event and hold onto any partial trailing bytes for next time. This is a real usage pattern worth knowing if you're ever framing your own protocol over a raw TCP socket in this codebase — it's already been solved once.

**Where this gets interesting**: it's used in exactly one place, `p2pClient.ts`'s own `on("data")` handler — parsing data the client receives back on its outbound connection to a peer. Tracing where that received data actually comes from turns up something worth documenting: **it never does anything**. The P2P server side (`host.ts`'s `p2pServer`, listening for *incoming* P2P connections from other nodes) parses arriving frames and routes them straight to `processEndpoints()` as an `/a/init` call — it never writes anything back to the socket. And nothing in the codebase subscribes to `p2pClient`'s `"message"` event, which is the only thing that receive-side parsing loop ever does with a completed frame. So the code compiles, looks functional, and would probably work if wired up — but as of `v4.1.0` it's dead: no server-side response is ever sent, and no client-side listener is ever attached. This is consistent with (and further confirms) [transport.md](transport.md)'s description of `send()` as genuinely fire-and-forget, not just "fire-and-forget in the common case."

Worth knowing if you're the one who eventually wires up a P2P response path (for the "Consensus Vote Reconciling" TODO mentioned in [transport.md](transport.md), for instance): the receive-side scaffolding — chunk buffering, frame reassembly, an event to hook into — is already there in `p2pClient.ts`, unused but ready. **One thing to fix if you do**: the server's outbound frame format would need to match what `ActiveFrame.read()` expects — the server-to-client direction has never been implemented, so there's no existing precedent for whether it should carry the same 40-byte sender-reference prefix the client-to-server direction uses (`ActiveFrame.read()` as written does not account for one).
