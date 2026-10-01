import sodium from "libsodium-wrappers";

interface SodiumKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}
const kxKeyPair = () => sodium.crypto_kx_keypair() as unknown as SodiumKeyPair;
type StateAddress = ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull>;

// The end-to-end channel between a device and the daemon, through The
// Nest (Nest-Protocol, ADR-017). Both ends are plain state machines over
// text frames, so the same code runs in Node and in the browser.

export const ready = () => sodium.ready;

export interface KeyPair {
  /** base64 */
  publicKey: string;
  privateKey: string;
}

const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const unb64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

/** A long-term key pair: the daemon's, or a device's (made at local pairing). */
export async function newKeyPair(): Promise<KeyPair> {
  await sodium.ready;
  const k = sodium.crypto_box_keypair();
  return { publicKey: b64(k.publicKey), privateKey: b64(k.privateKey) };
}

export class TunnelError extends Error {}

type Frame =
  | { t: "hello"; device: string; eph: string; nonce: string; proof: string }
  | { t: "welcome"; eph: string; nonce: string; proof: string }
  | { t: "stream"; header: string }
  | { t: "m"; c: string }
  | { t: "refused"; why: string };

/** What a received frame gave: decoded messages, and frames to send back. */
export interface Received {
  messages: unknown[];
  replies: string[];
}

abstract class End {
  #push: StateAddress | null = null;
  #pull: StateAddress | null = null;
  protected tx: Uint8Array | null = null;
  protected rx: Uint8Array | null = null;

  /** Both directions are open: messages can be sealed and read. */
  get ready() {
    return this.#push !== null && this.#pull !== null;
  }

  /** Starts this end's outgoing stream; its header is the first frame the other end reads. */
  protected openPush(): string {
    const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(
      this.tx as Uint8Array,
    );
    this.#push = state;
    return JSON.stringify({ t: "stream", header: b64(header) } satisfies Frame);
  }

  protected openPull(header: string) {
    this.#pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      unb64(header),
      this.rx as Uint8Array,
    );
  }

  /** One message, sealed for the other end. */
  seal(message: unknown): string {
    if (!this.#push) throw new TunnelError("The tunnel isn't open yet.");
    const c = sodium.crypto_secretstream_xchacha20poly1305_push(
      this.#push,
      sodium.from_string(JSON.stringify(message)),
      null,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    return JSON.stringify({ t: "m", c: b64(c) } satisfies Frame);
  }

  protected openMessage(c: string): unknown {
    if (!this.#pull) throw new TunnelError("A message came before the tunnel opened.");
    const r = sodium.crypto_secretstream_xchacha20poly1305_pull(this.#pull, unb64(c), null);
    // A frame changed, dropped or replayed fails here: the tunnel is closed.
    if (!r) throw new TunnelError("A frame failed its check; the tunnel is closed.");
    return JSON.parse(sodium.to_string(r.message));
  }

  protected parse(frame: string): Frame {
    try {
      return JSON.parse(frame) as Frame;
    } catch {
      throw new TunnelError("Not a tunnel frame.");
    }
  }
}

/** The device's end: it starts the handshake. */
export class DeviceEnd extends End {
  #eph: SodiumKeyPair | null = null;

  constructor(private readonly o: { deviceId: string; keys: KeyPair; daemonPublicKey: string }) {
    super();
  }

  /** The first frame: who I am, and a fresh key sealed to the daemon. */
  hello(): string {
    this.#eph = kxKeyPair();
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const proof = sodium.crypto_box_easy(
      this.#eph.publicKey,
      nonce,
      unb64(this.o.daemonPublicKey),
      unb64(this.o.keys.privateKey),
    );
    return JSON.stringify({
      t: "hello",
      device: this.o.deviceId,
      eph: b64(this.#eph.publicKey),
      nonce: b64(nonce),
      proof: b64(proof),
    } satisfies Frame);
  }

  receive(frame: string): Received {
    const f = this.parse(frame);
    if (f.t === "refused") throw new TunnelError(`The daemon refused: ${f.why}`);
    if (f.t === "welcome") {
      if (!this.#eph) throw new TunnelError("A welcome before my hello.");
      let opened: Uint8Array;
      try {
        opened = sodium.crypto_box_open_easy(
          unb64(f.proof),
          unb64(f.nonce),
          unb64(this.o.daemonPublicKey),
          unb64(this.o.keys.privateKey),
        );
      } catch {
        throw new TunnelError("The other end is not my daemon.");
      }
      const expected = new Uint8Array([...unb64(f.eph), ...this.#eph.publicKey]);
      if (!sodium.memcmp(opened, expected))
        throw new TunnelError("The daemon's proof doesn't match.");
      const keys = sodium.crypto_kx_client_session_keys(
        this.#eph.publicKey,
        this.#eph.privateKey,
        unb64(f.eph),
      );
      this.tx = keys.sharedTx;
      this.rx = keys.sharedRx;
      return { messages: [], replies: [this.openPush()] };
    }
    if (f.t === "stream") {
      this.openPull(f.header);
      return { messages: [], replies: [] };
    }
    if (f.t === "m") return { messages: [this.openMessage(f.c)], replies: [] };
    throw new TunnelError(`Unexpected frame: ${f.t}`);
  }
}

/** The daemon's end: it accepts paired devices only. */
export class DaemonEnd extends End {
  /** The paired device this tunnel belongs to, once its hello checked out. */
  deviceId: string | null = null;

  constructor(
    private readonly o: {
      keys: KeyPair;
      /** A paired, unrevoked device's public key, or null. */
      devicePublicKey: (deviceId: string) => string | null;
    },
  ) {
    super();
  }

  receive(frame: string): Received {
    const f = this.parse(frame);
    if (f.t === "hello") {
      const pk = this.o.devicePublicKey(f.device);
      if (!pk)
        return { messages: [], replies: [refusal("this device isn't paired, or was revoked")] };
      let eph: Uint8Array;
      try {
        eph = sodium.crypto_box_open_easy(
          unb64(f.proof),
          unb64(f.nonce),
          unb64(pk),
          unb64(this.o.keys.privateKey),
        );
      } catch {
        return { messages: [], replies: [refusal("the device's proof doesn't match its key")] };
      }
      if (!sodium.memcmp(eph, unb64(f.eph)))
        return { messages: [], replies: [refusal("the device's proof doesn't match its key")] };
      const mine = kxKeyPair();
      const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
      const proof = sodium.crypto_box_easy(
        new Uint8Array([...mine.publicKey, ...eph]),
        nonce,
        unb64(pk),
        unb64(this.o.keys.privateKey),
      );
      const keys = sodium.crypto_kx_server_session_keys(mine.publicKey, mine.privateKey, eph);
      this.tx = keys.sharedTx;
      this.rx = keys.sharedRx;
      this.deviceId = f.device;
      const welcome = JSON.stringify({
        t: "welcome",
        eph: b64(mine.publicKey),
        nonce: b64(nonce),
        proof: b64(proof),
      } satisfies Frame);
      return { messages: [], replies: [welcome, this.openPush()] };
    }
    if (!this.deviceId) return { messages: [], replies: [refusal("say hello first")] };
    if (f.t === "stream") {
      this.openPull(f.header);
      return { messages: [], replies: [] };
    }
    if (f.t === "m") return { messages: [this.openMessage(f.c)], replies: [] };
    throw new TunnelError(`Unexpected frame: ${f.t}`);
  }
}

const refusal = (why: string) => JSON.stringify({ t: "refused", why } satisfies Frame);
