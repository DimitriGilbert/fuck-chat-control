import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/components/docs-layout";

export const Route = createFileRoute("/docs/security")({
  component: SecurityComponent,
});

function SecurityComponent() {
  return (
    <DocsLayout title="Security, in plain language" activePath="/docs/security">
      <div className="docs-prose">
        <p>
          This is the user-facing security page. It says what the app actually protects, what it
          doesn&apos;t, and the one thing you have to do yourself for any of it to mean anything. If
          you want the formal version with byte layouts and closure decisions, that&apos;s the{" "}
          <a href="/docs/threat-model">threat model</a>.
        </p>

        <h2>The short version</h2>

        <p>
          Your messages are encrypted end-to-end with keys that live in your browser. The server
          that helps you and the other person connect &mdash; we call it the <em>broker</em> &mdash;
          cannot read them. It also doesn&apos;t keep them: once your direct connection opens, the
          broker is out of the path entirely. There&apos;s no account, no phone number, no message
          log stored anywhere, and nothing to log into.
        </p>

        <p>
          That said, this is v1, and v1 is honest about its limits. Three things worth knowing up
          front:
        </p>

        <ul>
          <li>
            <strong>You have to verify the safety number.</strong> If you don&apos;t, a
            well-positioned attacker could quietly substitute their own keys during the handshake
            and neither of you would notice. This is the one residual MITM risk and there is no app
            magic that fixes it.
          </li>
          <li>
            <strong>P2P means your peer sees your IP address.</strong> WebRTC peers learn each
            other&apos;s network candidates. The broker doesn&apos;t, but the person you&apos;re
            talking to does. If you need to hide your IP from the other party, use a VPN or Tor
            browser.
          </li>
          <li>
            <strong>Symmetric NATs don&apos;t connect.</strong> If you&apos;re behind one of those
            (roughly 10-20% of home networks, common on carrier-grade NAT), a direct WebRTC channel
            often won&apos;t establish. There is no TURN relay in v1 to fall back on. The connection
            just fails.
          </li>
        </ul>

        <h2>What&apos;s protected</h2>

        <ul>
          <li>
            The <strong>content of your messages</strong> against the broker. It sees signaling
            metadata and encrypted handshake bytes over DTLS-SRTP. It cannot read your traffic.
          </li>
          <li>
            Against <strong>network observers</strong> between peers. They see DTLS-SRTP encrypted
            data and TLS/WSS encrypted signaling.
          </li>
          <li>
            Against <strong>someone who copies your local message database</strong> without your
            browser&apos;s key material. The database is wrapped with an auto-generated at-rest key
            tied to the browser origin. A bare DB file is ciphertext.
          </li>
          <li>
            <strong>Forward secrecy across sessions.</strong> Every connection &mdash; first contact
            or resumption &mdash; uses fresh ephemeral ECDH P-256 keys run through HKDF-SHA256. A
            key compromise of one session does not retroactively decrypt past sessions.
          </li>
          <li>
            Against <strong>future compromise of the broker&apos;s logs</strong>, simply because
            there are no application logs to compromise.
          </li>
        </ul>

        <h2>What isn&apos;t protected</h2>

        <ul>
          <li>
            <strong>
              An active man-in-the-middle on the broker, if you do not compare the safety number.
            </strong>{" "}
            This is the big one. Without out-of-band verification, the channel is vulnerable and{" "}
            <em>the app cannot detect it</em>. There is no magic expected value to compare against;
            the only ground truth is what the two of you say to each other through a different
            channel (in person, a phone call, a different messenger).
          </li>
          <li>
            <strong>Your own device being compromised.</strong> Malware, a hostile browser
            extension, a keylogger, anyone who can read your unlocked browser profile &mdash; none
            of this is something in-browser crypto can defend against. A passphrase raises the bar
            against an <em>offline</em> copy of your profile but does nothing against an{" "}
            <em>online</em> attacker on a live device.
          </li>
          <li>
            <strong>Peer IP disclosure.</strong> The person you&apos;re talking to learns your IP
            address through WebRTC ICE candidates. The deployment&apos;s STUN listener sees your
            source IP for long enough to return a NAT mapping and discards it; it never sees a room
            ID or any content.
          </li>
          <li>
            <strong>Traffic analysis.</strong> A global passive adversary watching the timing and
            size of packets can learn things. Padding and traffic shaping are future work, not in
            v1.
          </li>
          <li>
            <strong>Availability.</strong> Anyone who gets the conversation ID (which is in the
            invitation link) can occupy the two broker slots, drop messages, or kill the handshake.
            Verifying the safety number authenticates <em>who you&apos;re talking to</em>; it does
            not guarantee the connection <em>works</em>.
          </li>
          <li>
            <strong>A malicious build.</strong> If someone serves you a tampered version of this
            app, no amount of cryptography helps you. Source inspection doesn&apos;t prove the
            deployed bytes match the source. If your threat model includes the operator, self-host
            or use reproducibly-built artifacts.
          </li>
          <li>
            <strong>Losing your at-rest key</strong> (e.g. by clearing browser site data). Persisted
            ciphertext becomes unrecoverable. Export/import is the backup mechanism &mdash; use it
            if you care about the history.
          </li>
        </ul>

        <h2>How to actually verify a conversation</h2>

        <p>
          After the handshake completes, both peers see a per-conversation{" "}
          <strong>safety number</strong>: a short string of grouped digits derived from the
          conversation ID and both identity public keys. Both sides display the <em>same</em> number
          for the same conversation. Until you mark it compared, the UI labels it
          &ldquo;unverified&rdquo; &mdash; loudly, on purpose.
        </p>

        <p>
          To verify, compare the number through a channel the attacker can&apos;t control. Read it
          out loud in person. Call the person on the phone (a phone call works &mdash; an attacker
          who controls the broker does not automatically control the phone network). Use a different
          messenger you already trust. <em>Do not paste it back into the same chat</em> &mdash; that
          defeats the entire point.
        </p>

        <p>
          If the numbers match, you have authenticated the channel against an active MITM. If they
          don&apos;t, stop. Tear the conversation down and start over through a different path.
          Mismatched safety numbers mean someone is in the middle, or one of you has the wrong
          identity key &mdash; either way, the channel is not private.
        </p>

        <h2 id="account">No accounts, no server state</h2>

        <p>
          There is no signup. No phone number, no email, no username. Your identity is an ECDSA
          P-256 keypair generated locally and stored in browser origin storage (scoped to this
          site). It is never sent to the broker or any server.
        </p>

        <p>
          The broker holds{" "}
          <strong>no persistent state, no presence table, and no message log</strong>. The two peers
          connect, exchange handshake bytes, and disconnect. Once the data channel is open, the
          broker is out of the path entirely. If the broker process is killed mid-conversation, your
          existing chat keeps working &mdash; it just can&apos;t help new conversations rendezvous
          until it&apos;s back.
        </p>

        <p>
          &ldquo;Never leaves the device&rdquo; means never sent to a network service. The one
          intentional exception is <strong>export/import</strong>: an explicit user action that
          writes your identity (and optionally history) to a file, encrypted under a passphrase you
          choose via Argon2id. That file is yours to move between browsers. If you don&apos;t
          export, you can&apos;t move the identity.
        </p>

        <h2 id="stun">STUN-only, and the NAT limit</h2>

        <p>
          WebRTC needs ICE candidates to set up a direct connection. For peers on loopback or the
          same LAN, the browser&apos;s host candidates are enough and no STUN server is needed at
          all. For peers across the open internet, the deployment runs a STUN listener on UDP 3478
          so each side can learn its own server-reflexive (public) address. That&apos;s the only
          thing STUN does here: tell you what your NAT mapping looks like.
        </p>

        <p>
          What STUN <em>doesn&apos;t</em> do is relay traffic. So if you sit behind a{" "}
          <strong>symmetric NAT</strong> &mdash; where every new destination gets a different source
          port &mdash; the two peers can&apos;t learn each other&apos;s mapped address in advance,
          and a direct connection generally fails. Carrier-grade NAT (the kind that ships with
          LTE/5G home routers and many ISPs) is the common case. Roughly 10-20% of home networks
          fall into this bucket, and v1 has no answer for them. The connection will not establish
          and you&apos;ll see an error in the UI. A future TURN-bearing release could fix this; v1
          does not.
        </p>

        <h2 id="adrs">The crypto underneath</h2>

        <p>
          If you want to audit the cryptographic choices, they&apos;re written down once, in one
          place. The v1 dependency set is:
        </p>

        <ul>
          <li>
            <code>@noble/curves</code> for P-256 ECDSA identity keys and ephemeral ECDH session
            keys. Public keys encoded as raw uncompressed SEC1 (65 bytes); signatures as IEEE-P1363
            <code>r || s</code> (64 bytes, not DER).
          </li>
          <li>
            Native WebCrypto for AES-256-GCM transport AEAD and at-rest encryption, HKDF-SHA256 for
            the key schedule, SHA-256 for transcript hashing and the safety number.
          </li>
          <li>
            <code>hash-wasm</code> for Argon2id, used only to wrap the at-rest key under an optional
            passphrase and to wrap the export/import bundle. Memory 64 MiB, 3 iterations,
            parallelism 1. Runs in a Web Worker so it doesn&apos;t block the UI.
          </li>
        </ul>

        <p>
          No PAKE in v1. Authentication is safety-number-only. A future SPAKE2 or OPAQUE mode could
          be added behind a narrow adapter, but it must not be assumed by any v1 module &mdash; and
          nothing about the current security claims depends on it existing. The full rationale is in{" "}
          <a href="/docs/threat-model">the threat model</a> and{" "}
          <a href="/docs/protocol">the protocol spec</a>.
        </p>
      </div>
    </DocsLayout>
  );
}
