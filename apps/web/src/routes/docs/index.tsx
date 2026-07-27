import { Link, createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/components/docs-layout";

export const Route = createFileRoute("/docs/")({
  component: DocsIndexComponent,
});

function DocsIndexComponent() {
  return (
    <DocsLayout title="Docs" activePath="/docs">
      <div className="docs-prose">
        <p>
          <strong>fuck-eu-chat-control</strong> is a peer-to-peer, in-browser chat app built to hold
          one property that most "secure" messengers quietly give up:{" "}
          <em>no server holds your messages, your keys, or even a way to decrypt them</em>. The
          broker that helps two peers find each other keeps no state, writes no logs, and is dropped
          from the data path the moment a direct WebRTC data channel opens. What travels between you
          and the other person is encrypted with keys that never leave your browser, authenticated
          by a safety number you compare out-of-band.
        </p>

        <p>
          This is v1, and v1 is intentionally narrow. There is no group chat, no message history
          sync across devices, no TURN relay, and no account system &mdash; your identity lives in
          browser storage scoped to this origin, optionally wrapped by a passphrase. The crypto is
          real (P-256 ECDSA identity, ephemeral ECDH, AES-256-GCM, HKDF-SHA256, Argon2id for at-rest
          wrapping), but the threat model has sharp edges you should understand before trusting it
          with anything serious. Read the security page first; the formal spec pages below are the
          source of truth if you want to verify a claim.
        </p>

        <p>
          The whole thing is{" "}
          <a
            href="https://github.com/DimitriGilbert/fck-chat-control"
            target="_blank"
            rel="noreferrer noopener"
          >
            open source
          </a>
          . That is not a footnote &mdash; for a tool whose entire point is &ldquo;nothing to hand
          over,&rdquo; being able to read every line, reproduce the build, fork it, and run your own
          instance is the guarantee. The crypto claims above are checkable against the protocol spec
          page; the deployment page shows exactly how to host it yourself instead of trusting a
          third party. If you find a flaw, open an issue or a pull request.
        </p>

        <h2>Pages</h2>
        <ul>
          <li>
            <Link to="/docs/security">Security, in plain language</Link>
            <br />
            <span className="text-muted-foreground">
              What&apos;s protected, what isn&apos;t, and how to actually verify a conversation.
              Start here.
            </span>
          </li>
          <li>
            <Link to="/docs/threat-model">Threat model</Link>
            <br />
            <span className="text-muted-foreground">
              The formal, standalone security reference. States plainly what v1 protects and what it
              does not protect against.
            </span>
          </li>
          <li>
            <Link to="/docs/protocol">Protocol v1 specification</Link>
            <br />
            <span className="text-muted-foreground">
              The frozen wire and cryptographic protocol. Byte layouts, constants, key schedule,
              frame format. Don&apos;t paraphrase it.
            </span>
          </li>
          <li>
            <Link to="/docs/deployment">Deployment guide</Link>
            <br />
            <span className="text-muted-foreground">
              How to run this yourself: single-process Nitro server, the one WSS route, STUN-only
              NAT traversal, and the logging posture operators must enforce.
            </span>
          </li>
        </ul>
      </div>
    </DocsLayout>
  );
}
